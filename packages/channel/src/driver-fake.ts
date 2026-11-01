import type { Context } from '@deepseek-ai/cordis'
import type {
  Capabilities,
  ChannelDriver,
  MemberChange,
  MessageSegment,
  UnifiedEvent,
  VenueKind,
} from './contracts.js'

/** Cordis 插件名。 */
export const name = 'driver-fake'

/** 只依赖渠道内核；runner 不存在时它保持待激活，不会报错。 */
export const inject = ['channels']

/** 一次出站调用的记录，测试与诊断用。 */
export interface SentCall {
  action: string
  params: unknown
}

export interface FakeDriver extends ChannelDriver {
  /** 模拟一条入站事件，等价于平台上真有人说话、或真有人进群。 */
  simulateInbound(input: {
    conversationId: string
    userId?: string
    name?: string
    text?: string
    conversationType?: VenueKind
    type?: 'message' | 'member'
    change?: MemberChange
  }): UnifiedEvent
  /** driver 收到的出站调用，按顺序。 */
  readonly sent: SentCall[]
}

export const capabilities: Capabilities = {
  sendImage: false,
  sendAudio: false,
  sendVideo: false,
  sendFile: false,
  sendQuote: false,
  sendMention: true,
  sendMentionAll: false,
  recall: false,
  maxMessageLength: 4096,
}

/**
 * 内存驱动：不出网络、不需要任何账号。
 *
 * 它的价值不是「像 QQ」，而是证明这条缝是真的 —— 内核在只认识
 * `ChannelDriver` 接口的情况下，能完整收发一轮。
 */
export function apply(ctx: Context): void {
  let handler: ((event: UnifiedEvent) => void) | undefined
  const sent: SentCall[] = []
  let sequence = 0

  const driver: FakeDriver = {
    protocol: 'fake',
    label: '内存驱动（无网络）',
    capabilities,
    actions: [
      {
        name: 'echo',
        description: '把一段文字原样发回当前会话。测试用。',
        parameters: { text: { type: 'string', required: true } },
        risk: 'read',
        reversible: true,
        scope: 'venue',
      },
    ],
    onEvent(next) {
      handler = next
    },
    async call(action, params) {
      sent.push({ action, params })
      return { ok: true }
    },
    simulateInbound(input) {
      const userId = input.userId ?? 'u-test'
      const segments: MessageSegment[] =
        input.type === 'member' || input.text === undefined
          ? []
          : [{ type: 'text', data: { text: input.text } }]
      const event: UnifiedEvent = {
        id: `fake-${++sequence}`,
        type: input.type ?? 'message',
        venue: { platform: 'fake', accountId: 'bot', conversationId: input.conversationId },
        conversationType: input.conversationType ?? 'group',
        timestamp: Date.now(),
        actor: { id: userId, ...(input.name === undefined ? {} : { name: input.name }) },
        self: false,
        messageId: `m-${sequence}`,
        message: segments,
        text: input.text ?? '',
        raw: { source: 'fake-driver', sequence },
      }
      if (handler === undefined) throw new Error('fake-driver: 内核还没接管 onEvent')
      handler(event)
      return event
    },
    get sent() {
      return sent
    },
  }

  // 注册即生效；driver 随本插件卸载自动注销。
  ctx.channels.registerDriver(driver)

  // 让测试能从 ctx 上拿到同一份对象（生产 driver 不需要这个）。
  ;(ctx.channels as unknown as { fake?: FakeDriver }).fake = driver
}
