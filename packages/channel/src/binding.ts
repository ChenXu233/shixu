import type { Context } from '@deepseek-ai/cordis'
import { venueKeyOf, type UnifiedEvent } from './contracts.js'

/** Cordis 插件名。 */
export const name = 'channel-binding'

/** 需要内核；`agents` 走嵌套 inject —— 它出现我才活，它消失我就停。 */
export const inject = ['channels']

/**
 * 我们只用得到 `ctx.agents` 的两件事：**第一次**为一个 sessionId 建 agent，
 * **之后**按 id 取回同一个 agent。其余一概不碰，换 agent 实现时不该影响绑定。
 *
 * 形状是回读安装包核对过的（dsh-agent / dsh-headless / dsh-llm）：
 *   - `create()` / `resume()` 都返回 **{ agent }**，不是 agent 本身；
 *   - `get(id)` 直接返回 agent；
 *   - 投递在 **agent.followup(message)** 上，参数是一条完整的 user 消息对象，
 *     不是 `{ content }`；它同步返回，不 await。
 * DSH 升级后必须重新核对这三点。
 */
interface AgentLike {
  followup(message: UserMessage): void
}

interface AgentsLike {
  /**
   * 恢复**或**新建：屏幕后是"先尝试从持久化恢复，只有 `SessionPersistenceNotFoundError`
   * 才走 create"（dsh-agent-loop）。所以这里不用自己判断"有没有历史"——
   * 用 create 去建一个已存在的 sessionId 会抛错，而那个错会被队列吞掉。
   */
  resume(options: { resumeSessionId: string }): Promise<{ agent: AgentLike }>
  get(id: string): AgentLike | undefined
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
 * 铁律：**一个场所 = 一个 session + 一个 agent**。
 * 这张表就是「同一个人同时挂在多个群」的唯一落地方式。
 */
export function apply(ctx: Context): void {
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

      serialize(venue, async () => {
        const agent = await open(venue, agents, live)
        agent.followup(toUserMessage(renderInbound(event)))
      })
    })
  })
}

/** 取不到就建一个。同一场所永远只会有一个 agent。 */
async function open(
  venue: string,
  agents: AgentsLike,
  live: Map<string, AgentLike>,
): Promise<AgentLike> {
  const existing = live.get(venue)
  if (existing !== undefined) return existing

  const sessionId = `shixu-${venue}`
  const agent = agents.get(sessionId) ?? (await agents.resume({ resumeSessionId: sessionId })).agent
  live.set(venue, agent)
  return agent
}
