/**
 * 渠道层的词汇表：只有类型与纯函数，没有插件、没有状态。
 *
 * 这份文件是 L1 与 L2 之间唯一的共同语言。driver 实现它，内核消费它，
 * 两边都不 import 对方的具体实现。
 */

export type EventType = 'message' | 'notice' | 'request' | 'meta'

export type DetailType = 'private' | 'group' | 'guild' | 'channel' | 'friend' | 'system'

/** 平台 + 账号二元组。裸 self_id 会在跨平台同号时相撞。 */
export interface SelfRef {
  platform: string
  accountId: string
  displayName?: string
}

/** 扁平 canonical 段 + native 透传。复杂结构一律走 `native`，不建树。 */
export interface MessageSegment {
  type: string
  data: Record<string, unknown>
  native?: unknown
}

export interface UnifiedEvent {
  /** 平台内唯一，用于去重。 */
  id: string
  type: EventType
  detailType: DetailType
  subType?: string
  self: SelfRef
  /** epoch ms */
  timestamp: number
  conversationId?: string
  threadId?: string
  userId?: string
  /** 发言人的显示名（群名片优先）。人格要叫得出人名，光有 id 不够。 */
  senderName?: string
  messageId?: string
  message?: MessageSegment[]
  text?: string
  /** 平台原始载荷：逃生舱，永不丢弃。 */
  raw: unknown
}

/**
 * 内核扇出的事件：`protocol` 已由内核盖上。
 *
 * 驱动写不出这个字段 —— 它在扇出时被覆盖写入，所以路由不可能被冒充。
 */
export interface KernelEvent extends UnifiedEvent {
  protocol: string
}

/** 一个「场所」的最小身份：哪个平台、哪个账号、哪个会话、哪个线程。 */
export interface VenueRef {
  platform: string
  accountId: string
  conversationId: string
  threadId?: string
}

/** 会话的稳定键。绑定表、去重、日志都共用这一个公式。 */
export function venueKey(ref: VenueRef): string {
  const parts = [ref.platform, ref.accountId, ref.conversationId]
  if (ref.threadId !== undefined && ref.threadId !== '') parts.push(ref.threadId)
  return parts.join(':')
}

/** 事件 → 场所键。没有 conversationId 的事件（notice / meta）不构成场所。 */
export function venueKeyOf(event: UnifiedEvent): string | undefined {
  if (event.conversationId === undefined) return undefined
  return venueKey({
    platform: event.self.platform,
    accountId: event.self.accountId,
    conversationId: event.conversationId,
    ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
  })
}

export interface ChatSession extends VenueRef {
  /** venueKey(session) */
  key: string
  /** 出站走哪条线缆。来自产出该事件的驱动，与 platform 不是一回事。 */
  protocol: string
  conversationType: 'private' | 'group' | 'guild' | 'channel'
}

/** driver 声明的能力。内核据此决定降级，而不是靠猜。 */
export interface Capabilities {
  sendImage: boolean
  sendAudio: boolean
  sendVideo: boolean
  sendFile: boolean
  sendCard: boolean
  sendMarkdown: boolean
  sendQuote: boolean
  sendMention: boolean
  sendMentionAll: boolean
  revokeMessage: boolean
  editMessage: boolean
  fetchHistory: boolean
  uploadFile: boolean
  maxMessageLength: number
  /** 仅被动回复的平台 */
  passiveReplyOnly: boolean
}

/** 一个平台一句可执行的声明，内核据此生成模型工具。 */
export interface ActionDescriptor {
  /** 'like' → 工具名 discord_like */
  name: string
  /** 给模型看：用途 + 代价 + 前置条件 */
  description: string
  /** 模型可填参数；不需要 bot_id */
  parameters: Record<string, unknown>
  risk: 'read' | 'write' | 'destructive'
  /** 动作能否撤回。不能撤回的动作不允许自主执行。 */
  reversible: boolean
  scope: 'chat' | 'account' | 'guild'
}

/**
 * 驱动的契约。
 *
 * 门 A（已抽象的动作）在这里声明；门 B（没有词表的能力）**不在这里** ——
 * 驱动自己把 MCP server 挂到场所的 agent 上，内核只凭 `mcp__` 前缀认得出
 * 「这不是我们的词表里的东西」，所以不允许它自主执行。
 */
export interface ChannelDriver {
  /** 注册表键 = 协议，不是平台：同一个 QQ 可以同时挂 OneBot 11 与官方 API。 */
  protocol: string
  label: string
  /** 门 A：已抽象的动作。 */
  actions: ActionDescriptor[]
  capabilities: Capabilities
  /** 内核把入站事件交给这里，driver 再回调 handler。 */
  onEvent(handler: (event: UnifiedEvent) => void): void
  /** 发一条消息或执行一个动作；由内核按会话路由到这里。 */
  call(action: string, params: unknown): Promise<unknown>
}

export interface Account {
  id: string
  platform: string
  accountId: string
  displayName?: string
  enabled: boolean
  protocol: string
  capabilities: Capabilities
}
