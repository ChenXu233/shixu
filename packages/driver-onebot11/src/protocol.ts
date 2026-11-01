/**
 * OneBot 11 的报文与统一事件之间的那层换算。
 *
 * 这里只有纯函数：收进来的 JSON 长什么样、发出去的段长什么样。
 * 传输（反向 WebSocket）在 transport.ts，插件装配在 index.ts。
 *
 * 协议本身是公开的：https://github.com/botuniverse/onebot-11
 */
import type { ActionDescriptor, Capabilities, MessageSegment, UnifiedEvent } from 'dsh-shixu-channel/contracts'

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
  comment?: string
  flag?: string
  sender?: { user_id?: number | string; nickname?: string; card?: string }
}

/** 只声明我们真的实现了的。没实现的写 true 会让内核按「支持」去做降级判断。 */
export const CAPABILITIES: Capabilities = {
  sendImage: true,
  sendAudio: true,
  sendVideo: true,
  sendFile: false,
  sendCard: true,
  sendMarkdown: false,
  sendQuote: true,
  sendMention: true,
  sendMentionAll: true,
  revokeMessage: true,
  editMessage: false,
  fetchHistory: false,
  uploadFile: false,
  maxMessageLength: 4000,
  passiveReplyOnly: false,
}

export const ACTIONS: ActionDescriptor[] = [
  {
    name: 'member_info',
    description: '查一个群成员的名片、头衔与入群时间。',
    parameters: { groupId: { type: 'string', required: true }, userId: { type: 'string', required: true } },
    risk: 'read',
    reversible: true,
    scope: 'chat',
  },
  {
    name: 'group_list',
    description: '列出机器人所在的所有群。',
    parameters: {},
    risk: 'read',
    reversible: true,
    scope: 'account',
  },
  {
    name: 'like',
    description: '给某个人的资料卡点赞。次数会被平台限制。',
    parameters: { userId: { type: 'string', required: true }, times: { type: 'number' } },
    risk: 'write',
    reversible: false,
    scope: 'account',
  },
  {
    name: 'recall',
    description: '撤回一条消息。撤回之后无法恢复。',
    parameters: { messageId: { type: 'string', required: true } },
    risk: 'write',
    reversible: false,
    scope: 'chat',
  },
  {
    name: 'ban',
    description: '禁言一个群成员若干秒，0 表示解除。可再用 0 解除，所以算可撤回。',
    parameters: {
      groupId: { type: 'string', required: true },
      userId: { type: 'string', required: true },
      durationSeconds: { type: 'number', required: true },
    },
    risk: 'write',
    reversible: true,
    scope: 'chat',
  },
  {
    name: 'kick',
    description: '把成员移出群。移出之后要靠邀请才能回来。',
    parameters: { groupId: { type: 'string', required: true }, userId: { type: 'string', required: true } },
    risk: 'destructive',
    reversible: false,
    scope: 'chat',
  },
  {
    name: 'set_card',
    description: '改群成员的群名片。',
    parameters: {
      groupId: { type: 'string', required: true },
      userId: { type: 'string', required: true },
      card: { type: 'string', required: true },
    },
    risk: 'write',
    reversible: true,
    scope: 'chat',
  },
]

/** 动作名 → OneBot 的 API 名与参数整形。 */
export const ACTION_API: Record<string, { api: string; build: (params: Record<string, unknown>) => Record<string, unknown> }> = {
  member_info: {
    api: 'get_group_member_info',
    build: (p) => ({ group_id: asId(p.groupId), user_id: asId(p.userId) }),
  },
  group_list: { api: 'get_group_list', build: () => ({}) },
  like: { api: 'send_like', build: (p) => ({ user_id: asId(p.userId), times: Number(p.times ?? 1) }) },
  recall: { api: 'delete_msg', build: (p) => ({ message_id: asId(p.messageId) }) },
  ban: {
    api: 'set_group_ban',
    build: (p) => ({ group_id: asId(p.groupId), user_id: asId(p.userId), duration: Number(p.durationSeconds ?? 0) }),
  },
  kick: { api: 'set_group_kick', build: (p) => ({ group_id: asId(p.groupId), user_id: asId(p.userId) }) },
  set_card: {
    api: 'set_group_card',
    build: (p) => ({ group_id: asId(p.groupId), user_id: asId(p.userId), card: String(p.card ?? '') }),
  },
}

/** OneBot 里 id 是数字，我们的会话里是字符串；空值一律当 0 交给平台去报错。 */
function asId(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 群名片优先，其次昵称。都没有就不给字段，别塞空串。 */
function senderNameOf(raw: RawEvent): { senderName?: string } {
  const card = raw.sender?.card
  const nickname = raw.sender?.nickname
  const name = card !== undefined && card !== '' ? card : nickname
  return name === undefined || name === '' ? {} : { senderName: name }
}

/** OneBot 11 的时间戳是秒。 */
function toMillis(seconds: unknown): number {
  const n = Number(seconds)
  return Number.isFinite(n) ? n * 1000 : Date.now()
}

/** 一条原始消息 → 统一事件。不认识的报文返回 undefined，不猜。 */
export function normalize(raw: RawEvent, platform: string): UnifiedEvent | undefined {
  if (raw === null || typeof raw !== 'object') return undefined

  const self = { platform, accountId: String(raw.self_id ?? '') }
  const timestamp = toMillis(raw.time)

  if (raw.post_type === 'meta_event') {
    // 心跳太吵，而且内核不需要它来判断在场。
    if (raw.meta_event_type === 'heartbeat') return undefined
    return {
      id: `meta:${self.accountId}:${timestamp}`,
      type: 'meta',
      detailType: 'system',
      self,
      timestamp,
      raw,
    }
  }

  if (raw.post_type === 'message' || raw.post_type === 'message_sent') {
    const segments = fromOneBotMessage(raw.message, raw.raw_message)
    const group = raw.message_type === 'group' || raw.message_type === 'guild'
    return {
      id: `msg:${self.accountId}:${String(raw.message_id ?? '')}`,
      type: 'message',
      detailType: raw.message_type === 'guild' ? 'guild' : group ? 'group' : 'private',
      ...(raw.sub_type === undefined ? {} : { subType: raw.sub_type }),
      self,
      timestamp,
      conversationId: group ? String(raw.group_id ?? '') : String(raw.user_id ?? ''),
      userId: String(raw.sender?.user_id ?? raw.user_id ?? ''),
      ...senderNameOf(raw),
      messageId: String(raw.message_id ?? ''),
      message: segments,
      text: renderText(segments),
      raw,
    }
  }

  if (raw.post_type === 'notice') {
    const detailType = String(raw.notice_type ?? '').startsWith('group_')
      ? 'group'
      : String(raw.notice_type ?? '').startsWith('friend_')
        ? 'friend'
        : 'system'
    return {
      id: `notice:${self.accountId}:${String(raw.notice_type ?? '')}:${String(raw.user_id ?? '')}:${timestamp}`,
      type: 'notice',
      detailType,
      ...(raw.notice_type === undefined ? {} : { subType: raw.notice_type }),
      self,
      timestamp,
      ...(raw.group_id === undefined ? {} : { conversationId: String(raw.group_id) }),
      ...(raw.user_id === undefined ? {} : { userId: String(raw.user_id) }),
      raw,
    }
  }

  if (raw.post_type === 'request') {
    return {
      id: `request:${self.accountId}:${String(raw.request_type ?? '')}:${String(raw.user_id ?? '')}:${timestamp}`,
      type: 'request',
      detailType: raw.request_type === 'group' ? 'group' : 'friend',
      ...(raw.request_type === undefined ? {} : { subType: raw.request_type }),
      self,
      timestamp,
      ...(raw.group_id === undefined ? {} : { conversationId: String(raw.group_id) }),
      ...(raw.user_id === undefined ? {} : { userId: String(raw.user_id) }),
      raw,
    }
  }

  return undefined
}

/** OneBot 消息段 → 统一段。认不出的原样留在 native 里，永不丢弃。 */
export function fromOneBotMessage(message: RawSegment[] | string | undefined, rawMessage?: string): MessageSegment[] {
  if (typeof message === 'string' && message !== '') return [{ type: 'text', data: { text: message } }]
  if (!Array.isArray(message)) return rawMessage === undefined || rawMessage === '' ? [] : [{ type: 'text', data: { text: rawMessage } }]
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
    case 'forward':
      return { type: 'node', data: { id: String(data.id ?? '') }, native: raw }
    case 'image':
    case 'video':
    case 'face':
    case 'json':
      return { type, data: { ...data }, native: raw }
    default:
      return { type, data: { ...data }, native: raw }
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
    case 'card':
    case 'json':
      return { type: 'json', data: { data: data.data } }
    default:
      return { type: segment.type, data: { ...data } }
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
      default:
        out += `[${segment.type}]`
    }
  }
  return out
}
