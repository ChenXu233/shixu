import type { Context } from '@deepseek-ai/cordis'
import { venueKeyOf, type UnifiedEvent } from './contracts.js'

/** Cordis 插件名。 */
export const name = 'channel-binding'

/** 需要内核；`agents` 走嵌套 inject —— 它出现我才活，它消失我就停。 */
export const inject = ['channels']

/**
 * 我们只用得到 `ctx.agents` 的两件事：**第一次**为一个 sessionId 建 agent，
 * **之后**按 id 取回同一个句柄。其余一概不碰，换 agent 实现时不该影响绑定。
 *
 * 形状取自 DSH 实测签名（create 返回句柄、get 按 id 找活着的 agent）；
 * DSH 升级后必须回读安装包核对。
 */
interface HandleLike {
  followup(input: { content: [{ type: 'text'; text: string }] }): Promise<unknown>
}

interface AgentsLike {
  create(options: { sessionId: string }): Promise<HandleLike>
  get(id: string): HandleLike | undefined
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
    const live = new Map<string, HandleLike>()
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
        const handle = await open(venue, agents, live)
        await handle.followup({ content: [{ type: 'text', text: renderInbound(event) }] })
      })
    })
  })
}

/** 取不到就建一个。同一场所永远只会有一个 agent。 */
async function open(
  venue: string,
  agents: AgentsLike,
  live: Map<string, HandleLike>,
): Promise<HandleLike> {
  const existing = live.get(venue)
  if (existing !== undefined) return existing

  const sessionId = `shixu-${venue}`
  const handle = agents.get(sessionId) ?? (await agents.create({ sessionId }))
  live.set(venue, handle)
  return handle
}
