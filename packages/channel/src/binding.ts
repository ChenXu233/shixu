import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { exposableActions, toolSpec } from './capabilities.js'
import { fetchImage } from './images.js'
import { createJournal, type Journal } from './journal.js'
import { judge, seedMatrix, turnActorOf, type PermissionMatrix, type TurnActor } from './permission.js'
import { venueKeyOf, type ChatSession, type KernelEvent, type UnifiedEvent } from './contracts.js'
import { Config, isVenueEnabled, personaDir, personaRoot, readField, type PersonaConfig } from './persona.js'

/** Cordis 插件名。 */
export const name = 'channel-binding'

/** 需要内核；`agents` 走嵌套 inject —— 它出现我才活，它消失我就停。 */
export const inject = ['channels']

/** 配置 schema 要给装载器与设置页看见。 */
export { Config }

/**
 * 我们只用得到 `ctx.agents` 的三件事：**第一次**为一个 sessionId 建 agent（带上 cwd），
 * **之后**按 id 取回同一个 agent，**已经落过盘**的会话恢复它。其余一概不碰。
 *
 * 形状是回读安装包核对过的（dsh-agent / dsh-session-persistence）：
 *   - `create` 收 `{ sessionId, meta: { cwd }, agentOptions }`，返回 **{ agent, dispose }**；
 *   - `resume` 只按 id 恢复，**没有 cwd 参数** —— 会话的 cwd 建好之后不再变；
 *   - `get(id)` 直接返回 agent；
 *   - 投递在 **agent.followup(message)** 上，参数是一条完整的 user 消息对象。
 * DSH 升级后必须重新核对这三点。
 */
interface AgentLike {
  followup(message: UserMessage): void
  /** agent 作用域：工具与提示词段挂在这里，只对这一条会话生效。 */
  ctx?: AgentScopeLike
}

interface AgentScopeLike {
  tools?: { register(definition: unknown): unknown }
  systemPrompt?: { section(section: { name: string; order: number; text: string; interpolate?: boolean }): unknown }
}

/** 模型三件套；省略表示跟随部署默认。 */
export interface AgentModel {
  provider?: string
  model?: string
  reasoningEffort?: string
}

interface AgentHandleLike {
  agent: AgentLike
}

interface AgentsLike {
  get(id: string): AgentLike | undefined
  create(options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: AgentModel }): Promise<AgentHandleLike>
  resume(options: { resumeSessionId: string; agentOptions?: AgentModel }): Promise<AgentHandleLike>
}

/** 工作区登记只需要三件事：有没有、建没建、把会话挂进去。 */
interface WorkspaceRecordLike {
  path: string
  title: string
  setTitle(title: string): Promise<void>
  attachSession?(sessionId: string): Promise<void>
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceRecordLike[]
  create(path: string, title?: string): Promise<unknown>
}

/** `session/event` 的最小形状：我们只读类型，剩下交给会话自己。 */
interface SessionEventLike {
  type: string
  data?: unknown
}

interface SessionContextLike {
  on(name: 'session/event', listener: (session: { id: string }, event: SessionEventLike) => void): () => boolean
}

interface Logger {
  info(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/**
 * 一条 user 消息。dsh 的 `createUserMessage` 就是 `{ ...input, role: 'user', id }`
 * 再冻结一次（dsh-llm/lib/index.js），所以这里直接造出来，不去依赖 dsh-llm 的副本 ——
 * 插件里多装一份 dsh 内部包，比这个形状更危险。
 */
export interface UserMessage {
  id: string
  role: 'user'
  /** 文本块，加上已经落成附件的图片块。 */
  content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: unknown }>
  source: { kind: 'user' }
}

/** 附件服务里我们用得到的那一件：把编码图片换成持久引用。 */
interface AttachmentsLike {
  admitPromptContent(content: unknown[]): Promise<unknown[]>
}

/** 一条入站消息变成一个 user 消息，id 每条唯一（平台消息 id 可能重复，不能拿来当它）。 */
export function toUserMessage(text: string): UserMessage {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 一条入站消息变成模型真正收到的内容。
 *
 * 图片要**先落成附件**再进消息：模型看到的是图，不是一个 `[image]` 字样。
 * 取不到图就退回纯文本，不让一张坏图吞掉整条消息。
 */
export async function toInboundMessage(
  event: KernelEvent,
  attachments: AttachmentsLike | undefined,
  log?: Logger,
  journal?: Journal,
): Promise<UserMessage> {
  const text = renderInbound(event)
  const images = await inboundImages(event, log, journal)
  if (images.length === 0 || attachments === undefined) return toUserMessage(text)

  const content = await attachments.admitPromptContent([{ type: 'text', text }, ...images])
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: content as UserMessage['content'],
    source: { kind: 'user' },
  }
}

/** 把事件里的图片段取回来；取不到的跳过，顺序保持原样。 */
async function inboundImages(
  event: KernelEvent,
  log?: Logger,
  journal?: Journal,
): Promise<Array<{ type: 'image'; data: string; mediaType: string }>> {
  const urls = (event.message ?? [])
    .filter((segment) => segment.type === 'image')
    .map((segment) => String((segment.data as { url?: unknown }).url ?? ''))
    .filter((url) => url !== '')

  const images: Array<{ type: 'image'; data: string; mediaType: string }> = []
  for (const url of urls) {
    try {
      const image = await fetchImage(url)
      if (image === undefined) {
        log?.info('图片取不到或不是图片，跳过：%s', url)
        journal?.note('image', `取不到或不是图片，跳过：${url}`)
        continue
      }
      images.push({ type: 'image', ...image })
    } catch (error) {
      log?.error('图片下载失败：%s', String(error))
      journal?.note('image', `下载失败：${url} —— ${String(error)}`)
    }
  }
  return images
}

/** 一条入站消息渲染成模型看到的样子。来源事实走前缀，不走 source kind。 */
export function renderInbound(event: UnifiedEvent): string {
  const { venue } = event
  const where = [venue.platform, venue.accountId, venue.conversationId, venue.threadId]
    .filter((part) => part !== undefined && part !== '')
    .join('/')
  const source = [
    `platform="${venue.platform}"`,
    `account="${venue.accountId}"`,
    `venue="${where}"`,
    `sender="${event.actor?.id ?? 'unknown'}"`,
    ...(event.actor?.name === undefined ? [] : [`sender_name="${event.actor.name}"`]),
    `message="${event.messageId ?? ''}"`,
  ].join(' ')
  return `<dsh_source ${source}/>\n${event.text ?? ''}`
}

/**
 * 从一条 assistant 消息里取出**给人看的话**。思考块和工具调用不算。
 */
export function saidText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const item = block as { type?: string; text?: unknown } | undefined
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .join('')
    .trim()
}

/**
 * 把场所事件变成一轮对话，再把人格的回答送回那个场所。
 *
 * 铁律：**一个场所 = 一个 session + 一个 agent**，而**所有场所共用一个 cwd**——
 * 那是人格自己的工作区。按场所分 cwd 会让每个群在侧栏变成一个项目，
 * 很快就没有人能从侧栏里认出这是一个人格。
 */
export function apply(ctx: Context, config: PersonaConfig): void {
  const personaId = readField<string>(config.personaId) ?? 'default'
  const dir = personaDir(personaRoot(), personaId)
  const title = `时煦-${personaId}`
  const log = ctx.logger('channel-binding')
  const journal = createJournal(dir)
  /**
   * 出错时两处都写：容器日志（能看见最好）和人格目录下的日志文件（一定看得见）。
   *
   * DSH 的插件日志不进 `docker logs`，只写第一处等于没写。
   */
  const fail = (scope: string, message: string): void => {
    log.error(message)
    journal.note(scope, message)
  }
  journal.note('boot', `persona=${personaId} cwd=${dir}`)
  const attachments = resolveAttachments(ctx)
  let workspace: Promise<WorkspaceRecordLike | undefined> | undefined

  /** 会话 → 回到哪个场所。agent 的回答要靠它找回原群。 */
  const targets = new Map<string, ChatSession>()
  /** 会话 → 这一轮已经说出来的话。一次 turn 只发一条，否则一句话会被拆成好几条。 */
  const pending = new Map<string, string[]>()
  /** 已经挂进工作区的会话，一个进程只挂一次。 */
  const attached = new Set<string>()
  /** 已经配好工具与人格段的会话，一个进程只配一次。 */
  const equipped = new Set<string>()
  /** 这些贡献挂在别人的作用域上，插件卸载时要自己收回来。 */
  const disposers: Array<() => void> = []
  let persona: Promise<string> | undefined
  /** 主人名单：唯一能跨场所的身份。读一次缓存住。 */
  let owners: Promise<string[]> | undefined
  /** 会话 → 这一回合是谁在说话。动作执行时按它判权限。 */
  const actors = new Map<string, TurnActor>()
  /** 平台 → 出厂权限矩阵。动作目录变了才会重算。 */
  const matrices = new Map<string, PermissionMatrix>()
  /** 会话 → 等这一轮结束的回调。同场所一次只服务一条消息，权限才不会张冠李戴。 */
  const turnDone = new Map<string, () => void>()

  ctx.effect(() => () => {
    for (const off of disposers.splice(0)) {
      try {
        off()
      } catch {
        /* 作用域可能先一步没了 */
      }
    }
  }, 'channel-binding.contributions')

  ctx.inject(['agents'], (scoped) => {
    const agents = (scoped as unknown as { agents: AgentsLike }).agents
    const live = new Map<string, AgentLike>()
    const queues = new Map<string, Promise<void>>()

    /**
     * 同一场所串行、不同场所并行。
     *
     * 这不是优化而是正确性：两条消息同时到达时，如果都先判断「还没有 agent」，
     * 就会重复创建、并且乱序投递。场所天然是串行的对话现场。
     */
    const serialize = (venue: string, task: () => Promise<void>): void => {
      const previous = queues.get(venue) ?? Promise.resolve()
      const next = previous.then(task, task).catch((error: unknown) => {
        // 事件不能因为一轮投递失败而静默消失。
        fail('deliver', `venue ${venue} 投递失败：${String(error)}`)
      })
      queues.set(venue, next)
      void next.then(() => {
        if (queues.get(venue) === next) queues.delete(venue)
      })
    }

    /**
     * 给一条会话装上它该有的东西：人格文本，和这个场所能自主执行的动作。
     *
     * 都挂在 `agent.ctx` 上 —— 作用域注册只对这一个 agent 可见，
     * 不会串到别的群，也不会污染全局工具表。
     */
    /** 等这一轮说完。没等到就超时放行 —— 卡住一条消息，比永远堵住这个场所强。 */
  const waitTurnEnd = (sessionId: string, timeoutMs = 120_000): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        turnDone.delete(sessionId)
        resolve()
      }, timeoutMs)
      turnDone.set(sessionId, () => {
        clearTimeout(timer)
        resolve()
      })
    })

  const equip = async (sessionId: string, agent: AgentLike, chat: ChatSession): Promise<void> => {
      if (equipped.has(sessionId)) return
      equipped.add(sessionId)

      const scope = agent.ctx
      if (scope === undefined) return

      persona ??= readPersonaText(dir)
      const text = await persona
      if (text !== '' && scope.systemPrompt !== undefined) {
        try {
          const off = scope.systemPrompt.section({ name: 'shixu:persona', order: 10, text, interpolate: false })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `人格提示段注册失败：${String(error)}`)
        }
      }

      const driver = ctx.channels.getDriver(chat.protocol)
      if (driver === undefined || scope.tools === undefined) return

      const actions = exposableActions(driver.actions ?? [])
      let matrix = matrices.get(chat.venue.platform)
      if (matrix === undefined) {
        matrix = seedMatrix(chat.venue.platform, actions)
        matrices.set(chat.venue.platform, matrix)
      }

      for (const action of actions) {
        try {
          const off = scope.tools.register({
            ...toolSpec(chat.venue.platform, action),
            output: {
              schema: { type: 'string' },
              render: (_args: unknown, value: unknown) => [
                { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
              ],
            },
            async execute(args: Record<string, unknown>) {
              // 权限在这里判，不在注册时判：一个场所只有一个 agent，工具列表是共用的，
              // 但「谁在说话」每回合都不一样。注册时拦等于把所有人当成同一个人。
              const actor = actors.get(sessionId)
              const role = actor?.role ?? 'guest'
              const decision = judge(matrix, role, toolSpec(chat.venue.platform, action).name)
              if (decision !== 'allow') {
                fail('permission', `${action.name} 被拒：${role}（${decision}）`)
                throw new Error(`没有权限：这条消息来自「${role}」，${action.name} 不在它的可执行范围内`)
              }

              return JSON.stringify(await driver.call(action.name, args ?? {}))
            },
          })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `工具注册失败（${action.name}）：${String(error)}`)
        }
      }
    }

    scoped.on('channels/event', (event: KernelEvent) => {
      // 只有「有人说话」才唤醒人格。成员变化是别的消费者的事（在场感、记忆）。
      if (event.type !== 'message') return
      // 自己说的话不叫醒自己：否则它一发出去就收到自己那条，接着回自己。
      if (event.self) return
      if ((event.text ?? '') === '') return
      const venue = venueKeyOf(event)
      if (!isVenueEnabled(config, venue)) return
      if (!isAddressed(event)) return

      const sessionId = `shixu-${venue}`
      const chat: ChatSession = {
        key: venue,
        venue: event.venue,
        protocol: event.protocol,
        conversationType: event.conversationType,
      }
      targets.set(sessionId, chat)

      serialize(venue, async () => {
        workspace ??= prepareWorkspace(ctx, dir, title, log, journal)
        const record = await workspace
        const agent = await open(sessionId, venue, agents, live, dir, model(config) ?? defaultModel(ctx), log, record, attached)
        await equip(sessionId, agent, chat)

        owners ??= readOwners(dir)
        actors.set(sessionId, turnActorOf(event, await owners))

        agent.followup(await toInboundMessage(event, attachments, log, journal))
        // 等同场所这一轮说完再投下一条：不然同群里两个人的消息会在一次回合里交错，
        // 权限判定就分不清是谁在让它动手。
        await waitTurnEnd(sessionId)
      })
    })
  })

  /**
   * 出站：人格说出来的话，回到它说话的那个场所。
   *
   * 挂在根上下文上 —— 会话事件是从会话服务那里发出来的，我们的插件上下文是它的兄弟，
   * 不是它的祖先。
   */
  ctx.effect(() => {
    const root = ctx.root as unknown as SessionContextLike
    const off = root.on('session/event', (session, event) => {
      const chat = targets.get(session.id)
      if (chat === undefined) return

      if (event.type === 'assistant/message') {
        const text = saidText((event.data as { message?: unknown } | undefined)?.message)
        if (text === '') return
        const said = pending.get(session.id) ?? []
        said.push(text)
        pending.set(session.id, said)
        return
      }

      if (event.type !== 'turn/end') return

      const said = pending.get(session.id) ?? []
      pending.delete(session.id)
      const text = said.join('\n\n').trim()
      if (text !== '') {
        void ctx.channels.send(chat, [{ type: 'text', data: { text } }]).catch((error: unknown) => {
          fail('reply', `venue ${chat.key} 回复发送失败：${String(error)}`)
        })
      }

      // 这一轮完了，同场所的下一条消息可以进来了。
      const done = turnDone.get(session.id)
      if (done !== undefined) {
        turnDone.delete(session.id)
        done()
      }
    })
    return () => void off?.()
  }, 'channel-binding.replies')
}

/**
 * 跟随部署默认：读 `agentDefaultModel` 现在选的是哪个。
 *
 * 不读这一个，会话就没有模型 —— prompt 里的 `{{model}}` 变量没人填，
 * 每一轮都在装配阶段直接失败，群里一句话都不会有。
 */
type DefaultModelLike = { currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } }

function defaultModel(ctx: Context): AgentModel | undefined {
  try {
    // 从根上下文找：这个服务是可选依赖，进不了 inject 名单，插件自己的作用域里看不见它。
    // 服务没装时读属性或 get() 都可能抛 —— 缺了就当没配。
    const probe = ctx.root as unknown as { get?(name: string): unknown; agentDefaultModel?: DefaultModelLike }
    const owner = probe.agentDefaultModel ?? (typeof probe.get === 'function' ? (probe.get('agentDefaultModel') as DefaultModelLike | undefined) : undefined)
    if (owner === undefined) return undefined
    const selection = owner.currentSelection()
    if (selection.provider === undefined || selection.model === undefined) return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  } catch {
    return undefined
  }
}

/**
 * 现在该不该开口。
 *
 * 私聊必回；群与频道里只在被 @ 到时开口。一个群里有人聊天不代表在叫它 ——
 * 逐条接话会把它变成噪音源，而噪音源会被踢出去。
 */
export function isAddressed(event: KernelEvent): boolean {
  if (event.conversationType === 'private') return true
  const self = event.venue.accountId
  return (event.message ?? []).some((segment) => {
    if (segment.type !== 'mention') return false
    const userId = (segment.data as { userId?: unknown }).userId
    return typeof userId === 'string' && userId === self
  })
}

/** 附件服务是可选依赖：没有它，图片就退回成纯文本，消息照样送进去。 */
function resolveAttachments(ctx: Context): AttachmentsLike | undefined {
  try {
    const probe = ctx.root as unknown as { get?(name: string): unknown; attachments?: AttachmentsLike }
    return probe.attachments ?? (typeof probe.get === 'function' ? (probe.get('attachments') as AttachmentsLike | undefined) : undefined)
  } catch {
    return undefined
  }
}

/** 主人名单。没有这个文件就没人跨场所是主人 —— 群里的管理员仍然是 trusted。 */
async function readOwners(dir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8')) as { owners?: unknown }
    if (!Array.isArray(raw.owners)) return []
    return raw.owners.filter((id): id is string => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

/** 人格文本。没有这个文件就是空字符串 —— 人格只是没写自我介绍，不是坏了。 */
async function readPersonaText(dir: string): Promise<string> {
  try {
    return (await readFile(join(dir, 'persona.md'), 'utf8')).trim()
  } catch {
    return ''
  }
}

/** 模型三件套；provider 或 model 缺一个就不指定，交给部署默认。 */
function model(config: PersonaConfig): AgentModel | undefined {
  const provider = readField<string>(config.provider)
  const id = readField<string>(config.model)
  if (provider === undefined || provider === '' || id === undefined || id === '') return undefined
  const effort = readField<string>(config.reasoningEffort)
  return { provider, model: id, ...(effort === undefined || effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * 人格工作区：先让目录存在，再登记成 DSH 项目。
 *
 * 登记是尽力而为 —— 目录在，会话就能建；登记失败只是侧栏里少一个分组，
 * 不该让整条回复链断掉。
 */
async function prepareWorkspace(
  ctx: Context,
  dir: string,
  title: string,
  log: Logger,
  journal: Journal,
): Promise<WorkspaceRecordLike | undefined> {
  await mkdir(dir, { recursive: true })
  const registry = (ctx as unknown as { get(name: string): WorkspaceRegistryLike | undefined }).get('workspaceRegistry')
  if (registry === undefined) return undefined
  try {
    const canonical = await realpath(dir)
    const existing = registry.list().find((item) => item.path === canonical)
    if (existing !== undefined) {
      // 名字是算出来的，不是存出来的：改过命名规则之后，已有的记录跟着改。
      if (existing.title !== title) await existing.setTitle(title)
      return existing
    }
    await registry.create(canonical, title)
    journal.note('workspace', `登记人格工作区：${canonical}`)
    return registry.list().find((item) => item.path === canonical)
  } catch (error) {
    log.error('人格工作区登记失败：%s', String(error))
    journal.note('workspace', `人格工作区登记失败：${String(error)}`)
    return undefined
  }
}

/** 取不到就建一个。同一场所永远只会有一个 agent。 */
async function open(
  sessionId: string,
  venue: string,
  agents: AgentsLike,
  live: Map<string, AgentLike>,
  dir: string,
  agentModel: AgentModel | undefined,
  log: Logger,
  workspace: WorkspaceRecordLike | undefined,
  attached: Set<string>,
): Promise<AgentLike> {
  const existing = live.get(venue)
  if (existing !== undefined) return existing

  const agent = agents.get(sessionId) ?? (await createOrResume(agents, sessionId, dir, agentModel, log))
  live.set(venue, agent)

  if (!attached.has(sessionId)) {
    attached.add(sessionId)
    // 没有 cwd 的老会话挂不进去（attachSession 会拒），这不影响回复，只是侧栏里看不到它。
    try {
      await workspace?.attachSession?.(sessionId)
    } catch {
      /* 老会话没有 cwd，登记不进去就算了 */
    }
  }
  return agent
}

/**
 * 第一次用 create（这是唯一能带上 cwd 的入口），已经落过盘就恢复。
 *
 * 反过来（先 resume）会给新会话造出一个没有 cwd 的 header，落在 `_no-cwd` 里 ——
 * 人格就没有工作区了。
 */
async function createOrResume(
  agents: AgentsLike,
  sessionId: string,
  dir: string,
  agentModel: AgentModel | undefined,
  log: Logger,
): Promise<AgentLike> {
  const options = agentModel === undefined ? {} : { agentOptions: agentModel }
  try {
    const handle = await agents.create({ sessionId, meta: { cwd: dir }, ...options })
    log.info('新场所会话 %s，cwd=%s', sessionId, dir)
    return handle.agent
  } catch (error) {
    if ((error as { name?: string } | undefined)?.name !== 'SessionAlreadyExistsError') throw error
    const handle = await agents.resume({ resumeSessionId: sessionId, ...options })
    return handle.agent
  }
}
