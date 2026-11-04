/**
 * 渠道层的词汇表：只有类型与纯函数，没有插件、没有状态。
 *
 * 这份文件是 L1 与 L2 之间唯一的共同语言。驱动实现它，内核消费它，
 * 两边都不 import 对方的具体实现。
 *
 * 设计原则：**只装「人格必须据此行动的事实」**。协议里有、但没人会因此做事的
 * 东西，一律留在 raw 里，不往这层搬。
 */

/** 事件只有两种：有人说了话，或者场所里的人变了。 */
export type EventType = 'message' | 'member'

/** 场所的三种形态。guild 不是场所 —— 频道才是。 */
export type VenueKind = 'private' | 'group' | 'channel'

/** 成员变化。平台怎么叫不重要，这五种是人格会因此做事的。 */
export type MemberChange = 'join' | 'leave' | 'kick' | 'promote' | 'demote'

/** 消息段的核心集合。其余一律 type='unknown' + native，不硬造名字。 */
export type SegmentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'file'
  | 'mention'
  | 'mentionAll'
  | 'quote'
  | 'unknown'

/** 扁平 canonical 段 + native 透传。复杂结构一律走 `native`，不建树。 */
export interface MessageSegment {
  type: SegmentType
  data: Record<string, unknown>
  /** 平台原始段：逃生舱，永不丢弃。 */
  native?: unknown
  /** `type='unknown'` 时给模型看的名字，如「表情」。 */
  label?: string
}

/** 一个「场所」的最小身份：哪个平台、哪个账号、哪个会话、哪个线程。 */
export interface VenueRef {
  platform: string
  accountId: string
  conversationId: string
  threadId?: string
}

/** 事件里涉及的人：发言人、入群人、被操作的人。 */
export interface Actor {
  id: string
  /** 显示名。光有 id 的话人格叫不出人名。 */
  name?: string
  /**
   * 平台在这一刻给这个人的角色（如 OneBot 的 `owner` / `admin` / `member`）。
   *
   * 只在场所里有意义，所以换场所就要重新取 —— A 群的管理员在 B 群什么都不是。
   * 内核不认识它的字面值，只按场所规则翻译成人格自己的角色。
   */
  role?: string
}

export interface UnifiedEvent {
  /** 平台内唯一，用于去重。 */
  id: string
  type: EventType
  /** 发生在哪个场所。 */
  venue: VenueRef
  conversationType: VenueKind
  /** epoch ms */
  timestamp: number
  /** 事件里的人。notice 类可能没有。 */
  actor?: Actor
  /** 是不是机器人自己干的。 */
  self: boolean
  messageId?: string
  message?: MessageSegment[]
  text?: string
  /** `type='member'` 时才有的：发生了什么变化。 */
  change?: MemberChange
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

/** 会话的稳定键。绑定表、去重、日志都共用这一个公式。 */
export function venueKey(ref: VenueRef): string {
  const parts = [ref.platform, ref.accountId, ref.conversationId]
  if (ref.threadId !== undefined && ref.threadId !== '') parts.push(ref.threadId)
  return parts.join(':')
}

/** 事件 → 场所键。事件一定发生在某个场所里。 */
export function venueKeyOf(event: UnifiedEvent): string {
  return venueKey(event.venue)
}

export interface ChatSession {
  /** venueKey(venue) */
  key: string
  venue: VenueRef
  /** 出站走哪条线缆。来自产出该事件的驱动，与 platform 不是一回事。 */
  protocol: string
  conversationType: VenueKind
}

/** driver 声明的能力。内核据此决定降级，而不是靠猜。只声明内核会用来做判断的。 */
export interface Capabilities {
  sendImage: boolean
  sendAudio: boolean
  sendVideo: boolean
  sendFile: boolean
  sendQuote: boolean
  sendMention: boolean
  sendMentionAll: boolean
  /** 能撤回自己发的消息。 */
  recall: boolean
  maxMessageLength: number
}

/** 一个动作一句可执行的声明，内核据此生成模型工具。 */
export interface ActionDescriptor {
  /** 平台无关的名字：'kick' → 工具名 qq_kick。 */
  name: string
  /** 给模型看：用途 + 代价 + 前置条件 */
  description: string
  /** 模型可填参数；不需要 bot_id */
  parameters: Record<string, unknown>
  risk: 'read' | 'write' | 'destructive'
  /** 动作能否撤回。不能撤回的动作不允许自主执行。 */
  reversible: boolean
  /** 'venue' 作用在本会话，'account' 作用在整个账号。 */
  scope: 'venue' | 'account'
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
  /** 线缆协议：'onebot11' | 'onebot12' | 'satori' | 'native:discord' */
  protocol: string
  capabilities: Capabilities
}
