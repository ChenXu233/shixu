/**
 * 这一批消息，要不要接。
 *
 * 默认沉默。这是三条实践来源的共同结论：过度主动会打断别人，过度保守只是像离线；
 * 而「像离线」比「打断别人」便宜得多，所以先从沉默开始，够格才开口。
 *
 * 现在用的是规则打分，不是模型判断。选规则的理由不是它更聪明，而是它**不花钱**：
 * 判定发生在每条消息进来时，用模型判定等于给每条群消息都买一次单。等这套跑顺了，
 * 换成一个便宜的判别器，接口不变。
 */
export interface Decision {
  act: 'speak' | 'silence'
  score: number
  /** 为什么这么判。写进日志，出问题能回溯「它当时怎么想的」。 */
  reasons: string[]
}

export interface DecisionInput {
  /** 还没判过的消息条数。 */
  pending: number
  /** 这条被 @ 了（结构化 mention）。 */
  mentioned: boolean
  /** 这条提到了它的名字。 */
  named: boolean
  /** 私聊。 */
  isPrivate: boolean
  /** 连着判了几次沉默。 */
  silenceStreak: number
  /** 距上次在这个场所说话过了多少毫秒；没说过按很久算。 */
  sinceLastSpokeMs: number
}

/** 开口的门槛。数值的出处是 policies.md，不在代码里另留一份口径。 */
export const SPEAK_THRESHOLD = 2

/** 打分：够格才开口。权重都写在一处，调的时候只改这里。 */
export function decide(input: DecisionInput): Decision {
  if (input.isPrivate) return { act: 'speak', score: 10, reasons: ['私聊必回'] }
  if (input.mentioned) return { act: 'speak', score: 10, reasons: ['被 @'] }
  if (input.named) return { act: 'speak', score: 8, reasons: ['提到名字'] }

  const neglected = Math.min(input.sinceLastSpokeMs / 600_000, 3) // 十分钟封顶
  const heat = input.pending * 0.5
  const backoff = input.silenceStreak * 0.5
  const score = heat + neglected - backoff

  const reasons = [
    `积压 ${input.pending} 条`,
    `久未开口 ${Math.round(input.sinceLastSpokeMs / 60_000)} 分钟`,
    `连续沉默 ${input.silenceStreak} 次`,
  ]

  return { act: score >= SPEAK_THRESHOLD ? 'speak' : 'silence', score: Math.round(score * 100) / 100, reasons }
}
