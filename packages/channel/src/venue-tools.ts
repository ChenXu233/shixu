/**
 * 内核给每个场所装的三件工具：看历史、指定发到哪、主动发一条。
 *
 * 为什么在渠道层而不是驱动里：它们说的是「这个会话里发生的事」，任何一个平台都有，
 * 只是消息 id 与出站段的形状不同 —— 那两样都由驱动负责，这里只用统一段。
 */
import type { ChatSession, MessageSegment } from './contracts.js'
import { PRINCIPAL_PARAMETER } from './capabilities.js'
import type { Perception } from './perception.js'

export interface VenueToolContext {
  /** 平台前缀，工具名按目录惯例带它（qq_history / qq_send）。 */
  platform: string
  /** 场所键，与感知缓冲同一个键。 */
  venueKey: string
  sessionId: string
  chat: ChatSession
  perception: Perception
  send(chat: ChatSession, segments: MessageSegment[]): Promise<unknown>
  /** 这一轮的正文挂到哪条消息下面。 */
  setOutbound(sessionId: string, messageId: string): void
}

export interface VenueTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<string>
}

export function venueTools(context: VenueToolContext): VenueTool[] {
  const { platform, venueKey, sessionId, chat, perception, send, setOutbound } = context

  return [
    {
      name: platform + '_history',
      description: '看看这个会话最近说了什么，每条前面带消息 id。回答更早的消息、要引用某一条时先用它。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '要几条，默认 20，最多 50' },
          principal: PRINCIPAL_PARAMETER,
        },
        required: ['principal'],
      },
      async run(args) {
        const limit = Math.max(1, Math.min(Number(args.limit ?? 20) || 20, 50))
        const recent = perception.state(venueKey)?.recent ?? []
        const lines = recent.slice(-limit).map((one) => {
          const who = one.name === undefined || one.name === '' ? one.subject : one.name
          const body = one.text === '' ? (one.images > 0 ? '[图片]' : '[空消息]') : one.text
          return '[' + one.id + '] ' + who + '：' + body
        })
        return lines.length === 0 ? '（这个会话还没有消息）' : lines.join('\n')
      },
    },
    {
      name: platform + '_reply_to',
      description: '指定：这一轮我说完的话，挂在哪条消息下面（引用回复）。只影响这一轮的正文。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: '取自 ' + platform + '_history 里的 id' },
          principal: PRINCIPAL_PARAMETER,
        },
        required: ['messageId', 'principal'],
      },
      async run(args) {
        const messageId = String(args.messageId ?? '').trim()
        if (messageId === '') throw new Error('messageId 不能为空')
        setOutbound(sessionId, messageId)
        return '好，这一轮我说完的话会挂在 [' + messageId + '] 下面'
      },
    },
    {
      name: platform + '_send',
      description: '立刻往这个会话发一条消息。想连发几条、或想在还没说完时先说一句，用它。正文回复会照常另发一条。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的话' },
          replyTo: { type: 'string', description: '可选：挂在哪条消息下面' },
          principal: PRINCIPAL_PARAMETER,
        },
        required: ['text', 'principal'],
      },
      async run(args) {
        const text = String(args.text ?? '').trim()
        if (text === '') throw new Error('text 不能为空')
        const replyTo = String(args.replyTo ?? '').trim()
        const segments: MessageSegment[] =
          replyTo === ''
            ? [{ type: 'text', data: { text } }]
            : [
                { type: 'quote', data: { messageId: replyTo } },
                { type: 'text', data: { text } },
              ]
        await send(chat, segments)
        return '已发送'
      },
    },
  ]
}
