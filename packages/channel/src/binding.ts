import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { exposableActions, PRINCIPAL_PARAMETER, toolSpec } from './capabilities.js'
import { fetchImage } from './images.js'
import { visitBrief } from './brief.js'
import { Budget } from './budget.js'
import { decide, QUIET_GAP_MS } from './decision.js'
import { createJournal, type Journal } from './journal.js'
import { appendLine, CORE_LIMIT, readCore, replaceLine, writeCore } from './memory.js'
import { accountKey, addAccount, addNote, readPeople, writePerson, type Person } from './people.js'
import { Perception } from './perception.js'
import { splitReply, typingDelay } from './timing.js'
import { venueTools } from './venue-tools.js'
import { judge, roleOf, seedMatrix, SELF, type Identity, type PermissionMatrix } from './permission.js'
import { venueKeyOf, type ChatSession, type KernelEvent, type MessageSegment, type UnifiedEvent } from './contracts.js'
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
  tools?: {
    register(definition: unknown): unknown
    /** 同步闸门：返回字符串就是拒绝的理由。 */
    guard?(check: (exec: unknown) => string | undefined): unknown
  }
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
  /** 会话 → 把它叫醒的那条消息（id + 时间），引用与否要看配置。 */
  const triggers = new Map<string, { id: string; at: number }>()
  /** 会话 → 模型让这一轮的正文挂到哪条消息下面（qq_reply_to 设的）。 */
  const outbound = new Map<string, string>()
  /** 已经挂进工作区的会话，一个进程只挂一次。 */
  const attached = new Set<string>()
  /** 已经配好工具与人格段的会话，一个进程只配一次。 */
  const equipped = new Set<string>()
  /** 这些贡献挂在别人的作用域上，插件卸载时要自己收回来。 */
  const disposers: Array<() => void> = []
  let persona: Promise<string> | undefined
  /**
   * 信任表：唯一能决定「谁能让它做什么」的东西。
   *
   * 闸门是同步的，所以读出来的值得提前放好 —— 启动时读一次，每条消息前再读一次，
   * 改了 identity.json 下一条消息就生效。
   */
  let trust: Identity = { owners: [], trusted: [] }
  /** 平台 → 出厂权限矩阵。动作目录变了才会重算。 */
  const matrices = new Map<string, PermissionMatrix>()
  /** 会话 → （消息 id → 谁说的）。会话事件只给消息 id，不给平台用户。 */
  const subjectsByMessage = new Map<string, Map<string, { subject: string; name?: string }>>()
  /** 会话 → 这一轮里真的开过口的人（id → 显示名）。动作执行时按它判权限。 */
  const speakers = new Map<string, Map<string, string | undefined>>()
  /** 每个场所听见了什么。没 @ 的消息也进这里，否则谈不上「在场」。 */
  const perception = new Perception()
  /** 场所键 → 会话信息。巡检醒来时要用它算出往哪发。 */
  const chats = new Map<string, ChatSession>()
  /** 它认识的人：账号 → 画像。小号和老号指向同一个人。 */
  let people = { byAccount: new Map<string, Person>(), byName: new Map<string, Person>() }
  /** 预算：同时看几个、一分钟说几句。 */
  const budget = new Budget(readField<number>(config.maxConcurrent) ?? 3, readField<number>(config.maxPerMinute) ?? 8)
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
  /**
   * 判定这次调用能不能做。
   *
   * 三步：先看它声明替谁做（不声明就按这一轮唯一的发言人算），再查这个人的角色，
   * 最后按矩阵判工具名。返回字符串就是拒绝的理由 —— 空字符串表示放行。
   */
  const denialFor = (sessionId: string, platform: string, exec: { name?: string; arguments?: unknown }): string => {
    const name = exec.name ?? ''
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const declared = typeof args.principal === 'string' ? args.principal.trim() : ''

    const speaking = speakers.get(sessionId) ?? new Map<string, string | undefined>()
    /** 昵称跟着账号一起给：模型不该自己去对「1964324406 是谁」。 */
    const named = (id: string): string => {
      const display = speaking.get(id)
      return display === undefined || display === '' ? '' : ` name=${display}`
    }

    let subject = ''
    if (declared === SELF) {
      subject = SELF
    } else if (declared !== '') {
      if (!speaking.has(declared)) {
        fail('permission', `拒绝 ${name}：${declared} 不是这一轮的发起人`)
        return `拒绝：tool=${name} principal=${declared} 原因=不是本轮的发起人`
      }
      subject = declared
    } else if (speaking.size === 1) {
      subject = [...speaking.keys()][0] ?? ''
    } else {
      // 一个场所一轮只该有一个人说话。真出现零个或两个，是我们的追踪坏了，
      // 按拒绝处理并记一笔 —— 但不为它设计话术，也不为它写测试：一千轮真实会话里
      // 一次都没发生过（同轮多条的，都是同一个人连发）。
      fail('permission', `拒绝 ${name}：本轮发起人不唯一（${[...speaking.keys()].join(',') || '无'}）`)
      return `拒绝：tool=${name} 原因=无法确定发起人`
    }

    const role = roleOf(subject, trust)
    const matrix = matrices.get(platform)
    if (matrix === undefined) return `拒绝：tool=${name} 原因=这个场所没有可用的动作目录`

    const decision = judge(matrix, role, name)
    if (decision === 'allow') return ''
    fail('permission', `拒绝 ${name}：${subject} 是 ${role}（${decision}）`)
    return `拒绝：tool=${name} principal=${subject}${named(subject)} role=${role} 原因=角色不允许`
  }

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

      // 它自己的记忆：写进 core.md，读进提示。有记忆它才知道该学什么。
      const coreSection = (memory: string): string =>
        memory === ''
          ? '（你还没有存下任何记忆。遇到以后还想得起来的事，就用 remember 记一笔。）'
          : '（下面是你自己记下的事。要用 remember 添加，或者用 remember 的 replaced 参数改掉记错的那条。）\n' + memory

      let coreOff: (() => void) | undefined
      const registerCore = async (): Promise<void> => {
        if (scope.systemPrompt === undefined) return
        const memory = await readCore(dir)
        if (coreOff !== undefined) {
          coreOff()
          coreOff = undefined
        }
        try {
          const off = scope.systemPrompt.section({
            name: 'shixu:core',
            order: 20,
            text: coreSection(memory),
            interpolate: false,
          })
          if (typeof off === 'function') {
            coreOff = off as () => void
            disposers.push(coreOff)
          }
        } catch (error) {
          fail('equip', `记忆提示段注册失败：${String(error)}`)
        }
      }
      await registerCore()

      const driver = ctx.channels.getDriver(chat.protocol)
      if (driver === undefined || scope.tools === undefined) return

      const actions = exposableActions(driver.actions ?? [])
      // history / search 由驱动提供（平台有历史接口）；内核补「怎么说」的两件。
      // remember 不给 guest：记忆会传染，陌生人不能往它脑子里写东西。
      const kernelNames = [`${chat.venue.platform}_reply_to`, `${chat.venue.platform}_send`]
      const ownerOnly = ['remember', 'link_account']
      let matrix = matrices.get(chat.venue.platform)
      if (matrix === undefined) {
        matrix = seedMatrix(chat.venue.platform, actions, kernelNames, ownerOnly)
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
              // principal 只是给判定看的，不往平台上传；场所身份随调用带上，
              // 模型不该自己背「这个群是哪个 group_id」。
              const { principal: _principal, ...params } = args ?? {}
              return JSON.stringify(await driver.call(action.name, { ...params, session: chat }))
            },
          })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `工具注册失败（${action.name}）：${String(error)}`)
        }
      }

      for (const tool of venueTools({
        platform: chat.venue.platform,
        venueKey: chat.key,
        sessionId,
        chat,
        perception,
        send: (target, segments) => ctx.channels.send(target, segments),
        setOutbound: (id, messageId) => outbound.set(id, messageId),
      })) {
        try {
          const off = scope.tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: {
              schema: { type: 'string' },
              render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
            },
            async execute(args: Record<string, unknown>) {
              const { principal: _principal, ...rest } = args ?? {}
              return await tool.run(rest)
            },
          })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `内核工具注册失败（${tool.name}）：${String(error)}`)
        }
      }

      // 三个记忆工具：自己的事、别人的事、把某个账号认成同一个人。
      const reloadPeople = async (): Promise<void> => {
        people = await readPeople(dir)
      }

      const memoryToolDefs = [
        {
          name: 'remember',
          description: '把以后还想得起来的事记进你自己的记忆（关于你自己和主人的）。改错时用 replaced 指定原文那一行。',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '要记下的一句话' },
              replaced: { type: 'string', description: '可选：要改掉的那一行的原文' },
              principal: PRINCIPAL_PARAMETER,
            },
            required: ['text', 'principal'],
          },
          async run(args: Record<string, unknown>) {
            const line = String(args.text ?? '').trim()
            if (line === '') throw new Error('text 不能为空')
            const replaced = String(args.replaced ?? '').trim()
            const current = await readCore(dir)
            const next = replaced === '' ? appendLine(current, line) : replaceLine(current, replaced, line)
            if (next.length > CORE_LIMIT) throw new Error(`记忆满了（${next.length}/${CORE_LIMIT} 字）：先用 replaced 合并掉几条旧的`)
            await writeCore(dir, next)
            await registerCore()
            journal.note('memory', `自己：${replaced === '' ? '追加' : '改写'} ${line}`)
            return '记下了'
          },
        },
        {
          name: 'remember_person',
          description: '把某个人说过的事记到他的画像里（他是谁、喜欢什么、最近在忙什么）。聊到谁就用谁的名字。',
          parameters: {
            type: 'object',
            properties: {
              person: { type: 'string', description: '这个人的名字（画像名）' },
              text: { type: 'string', description: '要记下的一句话' },
              principal: PRINCIPAL_PARAMETER,
            },
            required: ['person', 'text', 'principal'],
          },
          async run(args: Record<string, unknown>) {
            const name = String(args.person ?? '').trim()
            const line = String(args.text ?? '').trim()
            if (name === '' || line === '') throw new Error('person 与 text 都不能为空')
            const existing = people.byName.get(name) ?? { name, accounts: [], notes: [] }
            await writePerson(dir, addNote(existing, line))
            await reloadPeople()
            journal.note('memory', `${name}：${line}`)
            return '记到 ' + name + ' 名下了'
          },
        },
        {
          name: 'link_account',
          description: '把一个账号认成某个人：小号和老号指向同一份画像。账号写成 平台:id，例如 qq:123456。',
          parameters: {
            type: 'object',
            properties: {
              account: { type: 'string', description: '平台:id，例如 qq:123456' },
              person: { type: 'string', description: '画像名' },
              principal: PRINCIPAL_PARAMETER,
            },
            required: ['account', 'person', 'principal'],
          },
          async run(args: Record<string, unknown>) {
            const account = String(args.account ?? '').trim().toLowerCase()
            const name = String(args.person ?? '').trim()
            if (account === '' || name === '') throw new Error('account 与 person 都不能为空')
            const existing = people.byName.get(name) ?? { name, accounts: [], notes: [] }
            const next = addAccount(existing, account, people.byAccount)
            await writePerson(dir, next)
            await reloadPeople()
            journal.note('memory', `认人：${account} = ${name}`)
            return account + ' 记成 ' + name + ' 了'
          },
        },
      ]

      for (const tool of memoryToolDefs) {
        try {
          const off = scope.tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: {
              schema: { type: 'string' },
              render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
            },
            async execute(args: Record<string, unknown>) {
              const { principal: _principal, ...rest } = args ?? {}
              return await tool.run(rest)
            },
          })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `记忆工具注册失败（${tool.name}）：${String(error)}`)
        }
      }
      // 拦在闸门上而不是拦在注册时：一个场所只有一个 agent，工具列表是共用的，
      // 但每一轮是谁在说话都不一样。闸门也顺手管住了主机上的内置工具。
      if (typeof scope.tools.guard === 'function') {
        const off = scope.tools.guard((exec: unknown) => {
          const reason = denialFor(sessionId, chat.venue.platform, exec as { name?: string; arguments?: unknown })
          return reason === '' ? undefined : reason
        })
        if (typeof off === 'function') disposers.push(off as () => void)
      }
    }

  /**
   * 判一次「要不要去看一眼」。影子模式下只记日志，不叫醒。
   *
   * 延时是给一串短消息留的合并窗口：真人看群也是等一句话说完，不是逐字反应。
   */
  const judgeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // 安静巡检：没人说话的时候也要回去看看 —— 人会在群里冒一句「怎么不聊了」。
  // 只查已经安静够久的场所，否则每五分钟刷一遍日志。
  const quietTimer = setInterval(() => {
    const now = Date.now()
    for (const venue of perception.keys()) {
      const state = perception.state(venue)
      if (state === undefined) continue
      const last = state.recent.at(-1)?.at ?? state.firstSeenAt
      if (now - last < QUIET_GAP_MS) continue
      judgeVisit(venue, false)
    }
  }, 5 * 60_000)
  const scheduleJudge = (venue: string, isPrivate: boolean): void => {
    const running = judgeTimers.get(venue)
    if (running !== undefined) clearTimeout(running)
    const timer = setTimeout(() => {
      judgeTimers.delete(venue)
      judgeVisit(venue, isPrivate)
    }, readField<number>(config.judgeWindowMs) ?? 3_000)
    judgeTimers.set(venue, timer)
  }

  /** 同一个判定的收口：事件触发与安静巡检都走这里，日志格式只有一份。 */
  const judgeVisit = (venue: string, isPrivate: boolean): void => {
    const state = perception.state(venue)
    if (state === undefined) return
    const now = Date.now()
    const pending = state.pending.length
    const lastMessageAt = state.recent.at(-1)?.at ?? now
    const decision = decide({
      pending,
      mentioned: false,
      named: false,
      isPrivate,
      sinceLastVisitMs: state.lastVisitAt === 0 ? Number.MAX_SAFE_INTEGER : now - state.lastVisitAt,
      sinceLastMessageMs: now - lastMessageAt,
      sinceQuietVisitMs: state.lastQuietVisitAt === 0 ? Number.MAX_SAFE_INTEGER : now - state.lastQuietVisitAt,
      talkValue: readField<number>(config.talkValue) ?? 1,
      silenceStreak: state.silenceStreak,
    })
    const liveMode = (readField<string>(config.attention) ?? 'shadow') === 'live'
    // 安静去看过就记一笔，下次要等三个小时。
    if (decision.act === 'visit' && decision.reasons[0]?.includes('安静')) state.lastQuietVisitAt = now
    journal.note(
      'attention',
      `${venue} ${decision.act}${liveMode ? '' : '(影子)'} 积压=${pending} 静了=${Math.round((now - lastMessageAt) / 1000)}s｜${decision.reasons.join('，')}`,
    )
    if (decision.act === 'visit' && liveMode) wake(venue, state)
    else perception.markJudged(venue, decision.act === 'visit')
  }

  /** 醒过来：把它看到的最近几条交过去，说不说由它决定。 */
  const wake = (venue: string, state: { recent: Array<{ id: string; name?: string; subject: string; text: string; images: number; at: number }> }): void => {
    const chat = chats.get(venue)
    if (chat === undefined) return
    if (!budget.tryEnter(venue)) {
      journal.note('attention', `${venue} 跳过：并发已满（${budget.size()}）`)
      perception.markJudged(venue, false)
      return
    }

    const last = state.recent.at(-1)?.at ?? Date.now()
    const text = visitBrief({
      venueLabel: `${chat.venue.platform} ${chat.venue.conversationId}`,
      quietForMs: Date.now() - last,
      messages: state.recent.slice(-8),
    })
    const sessionId = `shixu-${venue}`
    targets.set(sessionId, chat)

    serialize(venue, async () => {
      try {
        workspace ??= prepareWorkspace(ctx, dir, title, log, journal)
        const record = await workspace
        const agent = await open(sessionId, venue, agents, live, dir, model(config) ?? defaultModel(ctx), log, record, attached)
        await equip(sessionId, agent, chat)
        trust = await readIdentity(dir)
        agent.followup(toUserMessage(text))
        perception.markJudged(venue, true)
      } finally {
        budget.leave(venue)
      }
    })
  }
    scoped.on('channels/event', (event: KernelEvent) => {
      // 只有「有人说话」才唤醒人格。成员变化是别的消费者的事（在场感、记忆）。
      if (event.type !== 'message') return
      // 自己说的话不叫醒自己：否则它一发出去就收到自己那条，接着回自己。
      if (event.self) return

      const venue = venueKeyOf(event)
      const aliases = readField<string[]>(config.aliasNames) ?? []
      const mentioned = isMentioned(event)
      const addressed = isAddressed(event, aliases)
      const text = event.text ?? ''
      const images = (event.message ?? []).filter((segment) => segment.type === 'image').length

      // 先记下来，再决定理不理。没 @ 的也要「听见」，否则它对群一无所知。
      if (text !== '' || images > 0) {
        chats.set(venue, {
          key: venue,
          venue: event.venue,
          protocol: event.protocol,
          conversationType: event.conversationType,
        })
        perception.observe(venue, {
          id: event.id,
          subject: event.actor?.id ?? '',
          name: event.actor?.name,
          text,
          images,
          at: event.timestamp,
        })
      }

      if (text === '') return
      if (!isVenueEnabled(config, venue)) return

      // 判定先跑影子模式：只记它「会不会接」，不改行为。等日志里能看出分寸了再放开。
      if (!addressed) {
        // 合成一批再判：一条一判等于永远「积压 1 条」，热度永远攒不起来。
        scheduleJudge(venue, event.conversationType === 'private')
        return
      }

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

        trust = await readIdentity(dir)

        if (event.messageId !== undefined && event.messageId !== '') {
          triggers.set(sessionId, { id: event.messageId, at: event.timestamp })
        }

        people = await readPeople(dir)

        const message = await toInboundMessage(event, attachments, log, journal)

        // 说话的人是谁：小号和老号指向同一份画像，它才不会「你谁啊」。
        const person = people.byAccount.get(accountKey(event.venue.platform, event.actor?.id ?? ''))
        if (person !== undefined) {
          const notes = person.notes.slice(-3).join('；').slice(0, 120)
          const which = person.accounts.length > 1 ? `，这是记在案的第 ${person.accounts.indexOf(accountKey(event.venue.platform, event.actor?.id ?? '')) + 1} 个账号` : ''
          message.content.unshift({
            type: 'text',
            text: `（说话的是 ${person.name}${which}。你记下的：${notes === '' ? '还没有' : notes}）`,
          })
        }
        // 会话事件只告诉我们「哪条消息进来了」，不告诉我们平台的用户 id。
        // 所以投递前先把消息 id 记下来，等 user/message 事件到了一查就知道是谁。
        const byMessage = subjectsByMessage.get(sessionId) ?? new Map<string, { subject: string; name?: string }>()
        byMessage.set(message.id, { subject: event.actor?.id ?? '', name: event.actor?.name })
        subjectsByMessage.set(sessionId, byMessage)

        agent.followup(message)
        perception.markJudged(venue, true)
      })
    })
  })

  /**
   * 一句话要带引用吗 —— 这是主人定的口味，不是引擎定的。
   *
   * `never`（默认）：真人不每句都引用，引用多了像客服系统。
   * `when-older`：答的不是最新那条时才引用 —— 那种时候不引用，群里真不知道在答哪句。
   * `always`：只在明确想要「每条都挂回原消息」的场合用。
   */
  const replySegments = (sessionId: string, chat: ChatSession, text: string): MessageSegment[] => {
    const plain: MessageSegment[] = [{ type: 'text', data: { text } }]
    const canQuote = ctx.channels.getDriver(chat.protocol)?.capabilities.sendQuote === true

    // 模型自己指定的优先：它调过 reply_to，就照它说的挂。
    const chosen = outbound.get(sessionId)
    if (chosen !== undefined) {
      outbound.delete(sessionId)
      if (canQuote && chat.conversationType !== 'private') {
        return [{ type: 'quote', data: { messageId: chosen } }, ...plain]
      }
      return plain
    }

    const mode = readField<string>(config.quote) ?? 'never'
    if (mode === 'never') return plain

    const trigger = triggers.get(sessionId)
    if (trigger === undefined || !canQuote || chat.conversationType === 'private') return plain

    if (mode === 'when-older') {
      // chat.key 与感知缓冲用的是同一个场所键（都来自 venueKeyOf）。
      const newer = (perception.state(chat.key)?.recent ?? []).some((message) => message.at > trigger.at)
      if (!newer) return plain
    }

    return [{ type: 'quote', data: { messageId: trigger.id } }, ...plain]
  }

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

      // 这一轮里谁真的开了口。权限判定只认这个集合 —— 不是「最近谁说过话」，
      // 更不是「平台上谁是管理员」。
      if (event.type === 'user/message') {
        const id = (event.data as { message?: { id?: unknown } } | undefined)?.message?.id
        const said = typeof id === 'string' ? subjectsByMessage.get(session.id)?.get(id) : undefined
        if (said !== undefined) {
          const set = speakers.get(session.id) ?? new Map<string, string | undefined>()
          set.set(said.subject, said.name)
          speakers.set(session.id, set)
        }
        return
      }

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
      // 它选择不说话：醒是醒了，看看就走。这是正常反应，不是失败。
      const quiet = text.trim()
      if (quiet === '-' || quiet === '－' || quiet === '——') {
        journal.note('attention', `${chat.key} 看过，没说话`)
        return
      }

      if (text !== '') {
        if (!budget.allowSpeak()) {
          journal.note('attention', `${chat.key} 跳过发送：这一分钟说得够多了`)
          return
        }
        budget.noteSpoke()

        // 像人那样发：先停一下，说一句，再看要不要补一句。
        const chunks = splitReply(text, readField<number>(config.replyMaxChunks) ?? 3)
        const base = readField<number>(config.typingDelayMs) ?? 600
        void (async () => {
          for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index] ?? ''
            const wait = typingDelay(chunk, base)
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
            // 只有第一条挂引用：后面几条是接着说，不需要每条都指回原消息。
            const segments: MessageSegment[] =
              index === 0 ? replySegments(session.id, chat, chunk) : [{ type: 'text', data: { text: chunk } }]
            await ctx.channels.send(chat, segments)
          }
        })().catch((error: unknown) => {
          fail('reply', `venue ${chat.key} 回复发送失败：${String(error)}`)
        })
      }

      // 一轮结束，说话人清空：下一条消息重新算，不继承上一轮的身份。
      speakers.delete(session.id)
      subjectsByMessage.delete(session.id)
      outbound.delete(session.id)
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
export function isAddressed(event: KernelEvent, aliases: readonly string[] = []): boolean {
  if (event.conversationType === 'private') return true
  if (isMentioned(event)) return true
  // 没 @ 但打了名字也算在叫它。群里有人聊到同名的人时会被误叫醒，
  // 所以只在名字是「不怎么出现在日常对话里的词」时才配。
  const text = event.text ?? ''
  return aliases.some((alias) => alias !== '' && text.includes(alias))
}

/** 结构化的 @：段里有 mention，且点的是它自己。 */
export function isMentioned(event: KernelEvent): boolean {
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

/**
 * 信任表：主人和他信得过的人。
 *
 * 没有这个文件就是「谁都不信」—— 所有人在人格眼里都是 guest，只能聊天和问只读的东西。
 * 平台说谁是群主不算数：群主管得着那个群，管不着这台机器。
 */
async function readIdentity(dir: string): Promise<Identity> {
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : []

  try {
    const raw = JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8')) as {
      owners?: unknown
      trusted?: unknown
    }
    return { owners: list(raw.owners), trusted: list(raw.trusted) }
  } catch {
    return { owners: [], trusted: [] }
  }
}

/**
 * 人设三段：我是谁 / 什么时候说话 / 怎么说话。
 *
 * 分开写不是洁癖：混成一段时，想调「别太活跃」就会改到性格上去。三份都是可选的，
 * 一份都没有才回落到老的单文件 persona.md。
 */
const PERSONA_PARTS = [
  { file: 'personality.md', title: '我是谁' },
  { file: 'behavior.md', title: '什么时候说话' },
  { file: 'reply_style.md', title: '怎么说话' },
]

/** 人格文本。没有这些文件就是空字符串 —— 人格只是没写自我介绍，不是坏了。 */
async function readPersonaText(dir: string): Promise<string> {
  const read = async (file: string): Promise<string> => {
    try {
      return (await readFile(join(dir, file), 'utf8')).trim()
    } catch {
      return ''
    }
  }

  const parts = await Promise.all(PERSONA_PARTS.map(async (part) => ({ ...part, text: await read(part.file) })))
  const filled = parts.filter((part) => part.text !== '')
  if (filled.length > 0) return filled.map((part) => `## ${part.title}\n${part.text}`).join('\n\n')

  return read('persona.md')
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
