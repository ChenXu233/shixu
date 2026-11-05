/**
 * 该不该去看一眼这个场所。
 *
 * 注意力不是「消息攒够了才搭理」—— 人是有空就溜一眼，安静久了也会回来看看，
 * 说一句「怎么不聊了」。所以这里判的是**要不要醒**，不是说哪句话：
 * 醒了以后说什么、说不说，是它自己的事。
 *
 * 三个旋钮（照 MaiBot 的做法）：
 *   talkValue      —— 一个人格说话多少的总量旋钮，0.3 明显话少、1.0 正常
 *   MIN_GAP / QUIET_GAP —— 两条时间线：刚看过别盯着、安静久了回去看看
 *   backoff        —— 连着判了几次沉默就更慢一点，别越没反应越勤快
 */
export interface Decision {
  act: 'visit' | 'silence'
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
  /** 距上次看这个场所过了多少毫秒。 */
  sinceLastVisitMs: number
  /** 距这个场所最后一条消息过了多少毫秒。 */
  sinceLastMessageMs: number
  /** 距上次「因为太安静去看」过了多少毫秒；没看过是很大的数。 */
  sinceQuietVisitMs: number
  /** 总量旋钮：越小越安静。1 = 正常。 */
  talkValue: number
  /** 连着判了几次沉默。 */
  silenceStreak: number
}

/** 刚看过就别盯着：一分钟内不重复醒（talkValue = 1 时）。 */
export const MIN_GAP_MS = 60_000

/** 安静这么久，回去看看它在不在（talkValue = 1 时）。 */
export const QUIET_GAP_MS = 30 * 60_000

/** 因为太安静去看过一次之后，隔这么久才再去。安静的地方不能每五分钟戳一次。 */
export const QUIET_REVISIT_MS = 3 * 60 * 60_000

/** 沉默得越久，检查得越慢；封顶五次，不然会彻底失联。 */
const backoffFactor = (silenceStreak: number): number => 1 + Math.min(silenceStreak, 5) * 0.2

/** 把总量旋钮换算成两条时间线。talkValue 越小，间隔越长。 */
export function gaps(talkValue: number, silenceStreak: number): { minGap: number; quietGap: number } {
  const scale = 1 / Math.min(Math.max(talkValue, 0.1), 3)
  const slow = backoffFactor(silenceStreak)
  return { minGap: MIN_GAP_MS * scale * slow, quietGap: QUIET_GAP_MS * scale * slow }
}

export function decide(input: DecisionInput): Decision {
  if (input.isPrivate) return { act: 'visit', reasons: ['私聊'] }
  if (input.mentioned) return { act: 'visit', reasons: ['被 @'] }
  if (input.named) return { act: 'visit', reasons: ['提到名字'] }

  const { minGap, quietGap } = gaps(input.talkValue, input.silenceStreak)
  if (input.sinceLastVisitMs < minGap) return { act: 'silence', reasons: ['刚看过'] }
  if (input.pending >= 2) return { act: 'visit', reasons: [`积压 ${input.pending} 条`] }

  // 太安静的时候去看一眼，但看完就等 —— 不然每轮巡检都会戳它一次。
  if (input.sinceLastMessageMs >= quietGap && input.sinceQuietVisitMs >= QUIET_REVISIT_MS) {
    return { act: 'visit', reasons: ['安静太久了，去看看'] }
  }
  return { act: 'silence', reasons: ['没什么事'] }
}
