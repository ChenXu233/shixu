/**
 * 它听见了什么。
 *
 * 现在所有没 @ 它的消息都在门口被丢掉，人格对群的「在场」等于零 —— 只有被点名的瞬间
 * 才存在。这里先做一个便宜的缓冲：不唤醒模型，只把最近的消息收着，等判定用得着。
 *
 * 三条来自实践（MaiBot / Ankole）的规矩：
 * 1. **先合并成批**：一串短消息是一件事，不该逐条吵醒模型；
 * 2. **每条只判一次**：判过就清空，不翻旧账（判过沉默的消息不会几轮后又被捞出来）；
 * 3. **缓冲有上限**：留最近 N 条，超了就丢最旧的 —— 记忆不是这里的事。
 */
export interface Perceived {
  id: string
  /** 平台用户 id。 */
  subject: string
  name?: string
  /** 纯文本；图片只记张数，内容由上层决定要不要转述。 */
  text: string
  images: number
  at: number
}

export interface VenueState {
  /** 还没判过的消息，按到达顺序。 */
  pending: Perceived[]
  /** 最近 N 条，判定和摘要都要看这个。 */
  recent: Perceived[]
  /** 连着几次判成沉默。连着沉默要放慢，这是 MaiBot 的 backoff。 */
  silenceStreak: number
  /** 上次在这个场所说话的毫秒时间戳；没说过是 0。 */
  lastSpokeAt: number
  /** 第一次听见这个场所的时刻。「多久没开口」要有起点，否则永远是 0。 */
  firstSeenAt: number
  /** 上次「看」这个场所的时刻（判过一次就算看过）。 */
  lastVisitAt: number
}

/** 一个场所留多少条。够判断「最近在聊什么」，又不至于把内存当记忆用。 */
export const RECENT_LIMIT = 50

export class Perception {
  private readonly venues = new Map<string, VenueState>()

  constructor(private readonly limit: number = RECENT_LIMIT) {}

  observe(venue: string, message: Perceived): VenueState {
    const state = this.venues.get(venue) ?? {
      pending: [],
      recent: [],
      silenceStreak: 0,
      lastSpokeAt: 0,
      firstSeenAt: message.at,
      lastVisitAt: 0,
    }
    state.pending.push(message)
    state.recent.push(message)
    if (state.recent.length > this.limit) state.recent.splice(0, state.recent.length - this.limit)
    if (state.pending.length > this.limit) state.pending.splice(0, state.pending.length - this.limit)
    this.venues.set(venue, state)
    return state
  }

  state(venue: string): VenueState | undefined {
    return this.venues.get(venue)
  }

  /** 现在挂着哪些场所。安静巡检要挨个看一遍。 */
  keys(): string[] {
    return [...this.venues.keys()]
  }

  /** 判过了就把这批清掉：判过的消息不再进入下一次判定。 */
  markJudged(venue: string, acted: boolean, at: number = Date.now()): void {
    const state = this.venues.get(venue)
    if (state === undefined) return
    state.pending = []
    state.lastVisitAt = at
    if (acted) {
      state.silenceStreak = 0
      state.lastSpokeAt = at
    } else {
      state.silenceStreak += 1
    }
  }

}
