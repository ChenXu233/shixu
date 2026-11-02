import { mkdir, realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { venueKeyOf, type UnifiedEvent } from './contracts.js'
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

/** 工作区登记只需要两件事：有没有、建没建。 */
interface WorkspaceRecordLike {
  path: string
  title: string
  setTitle(title: string): Promise<void>
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceRecordLike[]
  create(path: string, title?: string): Promise<unknown>
}

/**
 * 一条 user 消息。dsh 的 `createUserMessage` 就是 `{ ...input, role: 'user', id }`
 * 再冻结一次（dsh-llm/lib/index.js），所以这里直接造出来，不去依赖 dsh-llm 的副本 ——
 * 插件里多装一份 dsh 内部包，比这个形状更危险。
 */
export interface UserMessage {
  id: string
  role: 'user'
  content: [{ type: 'text'; text: string }]
  source: { kind: 'user' }
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
 * 把场所事件变成一轮对话。
 *
 * 铁律：**一个场所 = 一个 session + 一个 agent**，而**所有场所共用一个 cwd**——
 * 那是人格自己的工作区。按场所分 cwd 会让每个群在侧栏变成一个项目，
 * 很快就没有人能从侧栏里认出这是一个人格了。
 */
export function apply(ctx: Context, config: PersonaConfig): void {
  const personaId = readField<string>(config.personaId) ?? 'default'
  const dir = personaDir(personaRoot(), personaId)
  const title = `时煦-${personaId}`
  let workspace: Promise<void> | undefined

  ctx.inject(['agents'], (scoped) => {
    const agents = (scoped as unknown as { agents: AgentsLike }).agents
    const log = scoped.logger('channel-binding')
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
        log.error('venue %s 投递失败：%s', venue, String(error))
      })
      queues.set(venue, next)
      void next.then(() => {
        if (queues.get(venue) === next) queues.delete(venue)
      })
    }

    scoped.on('channels/event', (event: UnifiedEvent) => {
      // 只有「有人说话」才唤醒人格。成员变化是别的消费者的事（在场感、记忆）。
      if (event.type !== 'message') return
      if ((event.text ?? '') === '') return
      const venue = venueKeyOf(event)
      if (!isVenueEnabled(config, venue)) return

      serialize(venue, async () => {
        workspace ??= prepareWorkspace(scoped, dir, title, log)
        await workspace
        const agent = await open(venue, agents, live, dir, model(config), log)
        agent.followup(toUserMessage(renderInbound(event)))
      })
    })
  })
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
  log: { info(format: string, ...args: unknown[]): void; error(format: string, ...args: unknown[]): void },
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const registry = (ctx as unknown as { get(name: string): WorkspaceRegistryLike | undefined }).get('workspaceRegistry')
  if (registry === undefined) return
  try {
    const canonical = await realpath(dir)
    const existing = registry.list().find((item) => item.path === canonical)
    if (existing !== undefined) {
      // 名字是算出来的，不是存出来的：改过命名规则之后，已有的记录跟着改。
      if (existing.title !== title) await existing.setTitle(title)
      return
    }
    await registry.create(canonical, title)
    log.info('人格工作区：%s', canonical)
  } catch (error) {
    log.error('人格工作区登记失败：%s', String(error))
  }
}

/** 取不到就建一个。同一场所永远只会有一个 agent。 */
async function open(
  venue: string,
  agents: AgentsLike,
  live: Map<string, AgentLike>,
  dir: string,
  agentModel: AgentModel | undefined,
  log: { info(format: string, ...args: unknown[]): void },
): Promise<AgentLike> {
  const existing = live.get(venue)
  if (existing !== undefined) return existing

  const sessionId = `shixu-${venue}`
  const agent = agents.get(sessionId) ?? (await createOrResume(agents, sessionId, dir, agentModel, log))
  live.set(venue, agent)
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
  log: { info(format: string, ...args: unknown[]): void },
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
