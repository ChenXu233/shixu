/**
 * OneBot 11 的报文与统一事件之间的那层换算。
 *
 * 这里只有纯函数：收进来的 JSON 长什么样、发出去的段长什么样。
 * 传输（反向 WebSocket）在 transport.ts，插件装配在 index.ts。
 *
 * 协议本身是公开的：https://github.com/botuniverse/onebot-11
 *
 * 形状：**OneBot 的词汇不许出这个文件**。出去的只有 UnifiedEvent 里那几个
 * 语义字段；认不出的段变成 type='unknown'，原文留在 native。
 */
import type {
  ActionDescriptor,
  Capabilities,
  MemberChange,
  MessageSegment,
  UnifiedEvent,
  VenueKind,
} from 'dsh-shixu-channel/contracts'

/** 报文里我们读到的形状。只声明用得到的字段。 */
export interface RawSegment {
  type: string
  data?: Record<string, unknown>
}

export interface RawEvent {
  post_type?: string
  time?: number
  self_id?: number | string
  message_type?: string
  sub_type?: string
  notice_type?: string
  request_type?: string
  meta_event_type?: string
  message_id?: number | string
  message?: RawSegment[] | string
  raw_message?: string
  user_id?: number | string
  group_id?: number | string
  target_id?: number | string
  operator_id?: number | string
  sender?: { user_id?: number | string; nickname?: string; card?: string }
}

/** 只声明我们真的实现了的。没实现的写 true 会让内核按「支持」去做降级判断。 */
export const CAPABILITIES: Capabilities = {
  sendImage: true,
  sendAudio: true,
  sendVideo: true,
  sendFile: false,
  sendQuote: true,
  sendMention: true,
  sendMentionAll: true,
  recall: true,
  maxMessageLength: 4000,
}

/**
 * 核心动作：跨平台都说得通的那几个。
 *
 * 名字用平台无关的词（mute 不是 ban、set_role 不是 set_admin），因为
 * 工具名会是 `{platform}_{name}`，词得先在抽象里成立。
 * 点赞、群名片、贴表情这类只有一家有的东西不进目录 —— 等它们出现再说。
 */
export const ACTIONS: ActionDescriptor[] = [
  {
    name: 'member_list',
    description: '列出这个群里的人（id 与显示名）。',
    parameters: { groupId: { type: 'string', required: true } },
    risk: 'read',
    reversible: true,
    scope: 'venue',
  },
  {
    name: 'member_info',
    description: '查一个群成员的名片、头衔与入群时间。',
    parameters: { groupId: { type: 'string', required: true }, userId: { type: 'string', required: true } },
    risk: 'read',
    reversible: true,
    scope: 'venue',
  },
  {
    name: 'recall',
    description: '撤回一条消息。撤回之后无法恢复。',
    parameters: { messageId: { type: 'string', required: true } },
    risk: 'write',
    reversible: false,
    scope: 'venue',
  },
  {
    name: 'mute',
    description: '禁言一个群成员若干秒，0 表示解除。可以再用 0 解开，所以算可撤回。',
    parameters: {
      groupId: { type: 'string', required: true },
      userId: { type: 'string', required: true },
      durationSeconds: { type: 'number', required: true },
    },
    risk: 'write',
    reversible: true,
    scope: 'venue',
  },
  {
    name: 'kick',
    description: '把成员移出群。移出之后要靠邀请才能回来。',
    parameters: { groupId: { type: 'string', required: true }, userId: { type: 'string', required: true } },
    risk: 'destructive',
    reversible: false,
    scope: 'venue',
  },
  {
    name: 'set_role',
    description: '设或撤某人的管理员身份。可再设回去，所以算可撤回。',
    parameters: {
      groupId: { type: 'string', required: true },
      userId: { type: 'string', required: true },
      role: { type: 'string', enum: ['admin', 'member'], required: true },
    },
    risk: 'write',
    reversible: true,
    scope: 'venue',
  },
  {
    name: 'approve_join',
    description: '同意或拒绝一条入群申请。',
    parameters: {
      flag: { type: 'string', required: true },
      approve: { type: 'boolean', required: true },
    },
    risk: 'destructive',
    reversible: true,
    scope: 'venue',
  },
  {
    name: 'leave',
    description: '退出这个群。退出之后要靠别人重新邀请。',
    parameters: { groupId: { type: 'string', required: true } },
    risk: 'destructive',
    reversible: false,
    scope: 'venue',
  },
]

/** 动作名 → OneBot 的 API 名与参数整形。OneBot 的 snake_case 到此为止。 */
export const ACTION_API: Record<
  string,
  { api: string; build: (params: Record<string, unknown>) => Record<string, unknown> }
> = {
  member_list: { api: 'get_group_member_list', build: (p) => ({ group_id: asId(p.groupId) }) },
  member_info: {
    api: 'get_group_member_info',
    build: (p) => ({ group_id: asId(p.groupId), user_id: asId(p.userId) }),
  },
  recall: { api: 'delete_msg', build: (p) => ({ message_id: asId(p.messageId) }) },
  mute: {
    api: 'set_group_ban',
    build: (p) => ({ group_id: asId(p.groupId), user_id: asId(p.userId), duration: Number(p.durationSeconds ?? 0) }),
  },
  kick: { api: 'set_group_kick', build: (p) => ({ group_id: asId(p.groupId), user_id: asId(p.userId) }) },
  set_role: {
    api: 'set_group_admin',
    build: (p) => ({ group_id: asId(p.groupId), user_id: asId(p.userId), enable: p.role === 'admin' }),
  },
  approve_join: {
    api: 'set_group_add_request',
    build: (p) => ({ flag: String(p.flag ?? ''), approve: p.approve !== false }),
  },
  leave: { api: 'set_group_leave', build: (p) => ({ group_id: asId(p.groupId) }) },
}

/** OneBot 里 id 是数字，我们的会话里是字符串；空值一律当 0 交给平台去报错。 */
function asId(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** OneBot 11 的时间戳是秒。 */
function toMillis(seconds: unknown): number {
  const n = Number(seconds)
  return Number.isFinite(n) ? n * 1000 : Date.now()
}

/** 群名片优先，其次昵称。都没有就不给字段，别塞空串。 */
function nameOf(raw: RawEvent): { name?: string } {
  const card = raw.sender?.card
  const nickname = raw.sender?.nickname
  const name = card !== undefined && card !== '' ? card : nickname
  return name === undefined || name === '' ? {} : { name }
}

/** OneBot 的 notice 里哪几种是人格会因此做事的。其余一律丢掉（原文在 raw 里）。 */
function memberChangeOf(raw: RawEvent): MemberChange | undefined {
  switch (raw.notice_type) {
    case 'group_increase':
      return 'join'
    case 'group_decrease':
      return raw.sub_type === 'kick' || raw.sub_type === 'kick_me' ? 'kick' : 'leave'
    case 'group_admin':
      return raw.sub_type === 'set' ? 'promote' : 'demote'
    default:
      return undefined
  }
}

function venueKindOf(raw: RawEvent): VenueKind {
  if (raw.message_type === 'group') return 'group'
  if (raw.message_type === 'guild') return 'channel'
  return 'private'
}

/** 一条原始报文 → 统一事件。不认识的返回 undefined，不猜。 */
export function normalize(raw: RawEvent, platform: string): UnifiedEvent | undefined {
  if (raw === null || typeof raw !== 'object') return undefined

  const accountId = String(raw.self_id ?? '')
  const timestamp = toMillis(raw.time)
  const actorId = String(raw.sender?.user_id ?? raw.user_id ?? '')

  if (raw.post_type === 'message' || raw.post_type === 'message_sent') {
    const conversationType = venueKindOf(raw)
    const conversationId =
      conversationType === 'private' ? String(raw.user_id ?? '') : String(raw.group_id ?? '')
    const segments = fromOneBotMessage(raw.message, raw.raw_message)
    return {
      id: `msg:${accountId}:${String(raw.message_id ?? '')}`,
      type: 'message',
      venue: { platform, accountId, conversationId },
      conversationType,
      timestamp,
      actor: { id: actorId, ...nameOf(raw) },
      self: actorId === accountId,
      messageId: String(raw.message_id ?? ''),
      message: segments,
      text: renderText(segments),
      raw,
    }
  }

  const change = memberChangeOf(raw)
  if (change !== undefined) {
    return {
      id: `member:${accountId}:${change}:${actorId}:${timestamp}`,
      type: 'member',
      venue: { platform, accountId, conversationId: String(raw.group_id ?? '') },
      conversationType: 'group',
      timestamp,
      actor: { id: actorId },
      self: actorId === accountId,
      change,
      raw,
    }
  }

  return undefined
}

/** OneBot 消息段 → 统一段。认不出的变成 unknown，原文留在 native。 */
export function fromOneBotMessage(message: RawSegment[] | string | undefined, rawMessage?: string): MessageSegment[] {
  if (typeof message === 'string' && message !== '') return [{ type: 'text', data: { text: message } }]
  if (!Array.isArray(message)) {
    return rawMessage === undefined || rawMessage === '' ? [] : [{ type: 'text', data: { text: rawMessage } }]
  }
  return message.map(toSegment)
}

function toSegment(raw: RawSegment): MessageSegment {
  const type = String(raw.type ?? 'text')
  const data = (raw.data ?? {}) as Record<string, unknown>
  switch (type) {
    case 'text':
      return { type: 'text', data: { text: String(data.text ?? '') } }
    case 'at': {
      const qq = String(data.qq ?? '')
      return qq === 'all' ? { type: 'mentionAll', data: {} } : { type: 'mention', data: { userId: qq } }
    }
    case 'reply':
      return { type: 'quote', data: { messageId: String(data.id ?? '') }, native: raw }
    case 'record':
      return { type: 'audio', data: { file: String(data.file ?? '') }, native: raw }
    case 'image':
      return { type: 'image', data: { url: String(data.url ?? ''), file: String(data.file ?? '') }, native: raw }
    case 'video':
      return { type: 'video', data: { file: String(data.file ?? '') }, native: raw }
    case 'file':
      return { type: 'file', data: { file: String(data.file ?? ''), name: String(data.name ?? '') }, native: raw }
    case 'face':
      return { type: 'unknown', data: {}, label: '表情', native: raw }
    case 'json':
      return { type: 'unknown', data: {}, label: '卡片', native: raw }
    case 'forward':
      return { type: 'unknown', data: {}, label: '合并转发', native: raw }
    default:
      return { type: 'unknown', data: {}, label: type, native: raw }
  }
}

/** 统一段 → OneBot 消息段。native 优先：驱动认得的东西就别再解释一遍。 */
export function toOneBotMessage(segments: MessageSegment[]): RawSegment[] {
  return segments.map(toOutSegment)
}

function toOutSegment(segment: MessageSegment): RawSegment {
  if (segment.native !== undefined && segment.native !== null) return segment.native as RawSegment
  const data = segment.data
  switch (segment.type) {
    case 'text':
      return { type: 'text', data: { text: String(data.text ?? '') } }
    case 'mention':
      return { type: 'at', data: { qq: String(data.userId ?? '') } }
    case 'mentionAll':
      return { type: 'at', data: { qq: 'all' } }
    case 'quote':
      return { type: 'reply', data: { id: String(data.messageId ?? '') } }
    case 'image':
      return { type: 'image', data: { file: String(data.url ?? data.file ?? '') } }
    case 'audio':
      return { type: 'record', data: { file: String(data.file ?? '') } }
    case 'video':
      return { type: 'video', data: { file: String(data.file ?? '') } }
    case 'file':
      return { type: 'file', data: { file: String(data.file ?? ''), name: String(data.name ?? '') } }
    default:
      return { type: 'text', data: { text: '' } }
  }
}

/** 给人（和模型）读的纯文本。用平台原文会让模型看到一串 CQ 码。 */
export function renderText(segments: MessageSegment[]): string {
  let out = ''
  for (const segment of segments) {
    switch (segment.type) {
      case 'text':
        out += String(segment.data.text ?? '')
        break
      case 'mention':
        out += `@${String(segment.data.userId ?? '')}`
        break
      case 'mentionAll':
        out += '@全体成员'
        break
      case 'quote':
        break
      case 'unknown':
        out += `[${segment.label ?? '未知'}]`
        break
      default:
        out += `[${segment.type}]`
    }
  }
  return out
}
