/**
 * 它醒来时看到的那段话。
 *
 * 被 @ 时它看到的是那条消息本身；「回去看一眼」醒来时没有单条消息可看 —— 它看到的是
 * 这个群最近发生了什么，以及一个选择：说，还是不说。
 *
 * 不给它「必须回复」的暗示：安静的时候什么都没有，也是一种正常反应。
 */
export interface BriefMessage {
  id: string
  name?: string
  subject: string
  text: string
  images: number
}

export interface BriefInput {
  /** 给人看的场所名，例如 `QQ 群 615374518`。 */
  venueLabel: string
  /** 距最后一条消息多久。 */
  quietForMs: number
  /** 最近几条，按时间顺序。 */
  messages: readonly BriefMessage[]
}

/**
 * 它站在哪儿、说话怎么算发出去了。
 *
 * 这一段解释的是**这一轮怎么运作**：正文就是回复、工具各管什么、调用要声明替谁做。
 * 不写这些，模型只能从工具描述里反推，推错的代价是它用括号写旁白或者干脆不说话。
 */
export function venueSection(chat: { key: string; venue: { platform: string; conversationId: string }; conversationType: string }): string {
  const where =
    chat.conversationType === 'private'
      ? `你在 ${chat.venue.platform} 的私聊里。`
      : `你在 ${chat.venue.platform} 会话 ${chat.venue.conversationId} 里，这是群聊，里面有好几个人。`

  const replyTo = `${chat.venue.platform}_reply_to`
  const send = `${chat.venue.platform}_send`

  return [
    where,
    '你这轮最后说的话会原样发到这个会话里——**直接说话就是回复，不需要调用工具去发**。',
    `要指定这句话挂在哪条消息下面（引用回复），先调用 ${replyTo}；想额外再发一条，用 ${send}。`,
    '不想说话就调用 stay_quiet：调了它之后，这一轮你说的任何话都不会被发出去，正文写了什么都不发。',
    '调用任何工具都要带 principal：这一轮是为谁做的。值是这个人的用户 id，或者 self 表示你自己要做的。',
    '不要用括号描写动作或心理（比如「（沉默）」「（点点头）」）——这里只有文字消息，那些括号会被原样发出去。',
  ].join('\n\n')
}

/** 安静多久算「安静」。一分钟以内不说，免得它以为群里出事了。 */
const QUIET_MIN_MS = 60_000

export function visitBrief(input: BriefInput): string {
  const minutes = Math.floor(input.quietForMs / 60_000)
  const seen =
    input.messages.length === 0
      ? '这个会话还没有消息。'
      : input.messages
          .map((one) => {
            const who = one.name === undefined || one.name === '' ? one.subject : one.name
            const body = one.text === '' ? (one.images > 0 ? '[图片]' : '[空消息]') : one.text
            return `[${one.id}] ${who}：${body}`
          })
          .join('\n')

  const quiet =
    input.quietForMs >= QUIET_MIN_MS ? `已经 ${minutes} 分钟没人说话了。` : '刚才这些是最近的消息。'

  return [
    `（你在「${input.venueLabel}」里。${quiet}）`,
    seen,
    '（想接着说就接一句；插不上话、或者不该你插嘴，就调用 stay_quiet 安静待着。）',
  ].join('\n')
}
