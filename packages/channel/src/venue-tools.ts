/**
 * 内核给每个场所补的两件工具：指定这一轮发到哪、主动发一条。
 *
 * 为什么不是驱动的事：`reply_to` 不是平台能力，它是「把这条回复挂回哪条消息」的出站指令；
 * `send` 走的是内核的出站路径（和自动回复同一条）。读历史那种要问平台的事，归驱动。
 */
import type { ChatSession, MessageSegment } from './contracts.js'
import { PRINCIPAL_PARAMETER } from './capabilities.js'
import type { Perception } from './perception.js'

export interface VenueToolContext {
  /** 平台前缀，工具名按目录惯例带它（qq_reply_to / qq_send）。 */
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
  const { platform, sessionId, chat, send, setOutbound } = context

  return [
    {
      name: platform + '_reply_to',
      description: '指定：这一轮我说完的话，挂在哪条消息下面（引用回复）。只影响这一轮的正文。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: '取自历史里的消息 id' },
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
