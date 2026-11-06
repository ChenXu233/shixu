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
    '（你想接着聊就接一句；觉得没什么好说的，就别出声。）',
  ].join('\n')
}
