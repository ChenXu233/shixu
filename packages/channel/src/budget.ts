/**
 * 说话是有配额的。
 *
 * 判定决定「该不该去看」，配额决定「同时能看几个、一分钟总共能说几句」。
 * 没有它的话，十个群同时热闹 = 十个模型请求一起跑、十条消息一起发出去。
 *
 * 两个数字都从 policies 来：并发 3、全局每分钟 8 条。
 */
export class Budget {
  private readonly running = new Set<string>()
  private stamps: number[] = []

  constructor(
    private readonly maxConcurrent: number = 3,
    private readonly maxPerMinute: number = 8,
    private readonly windowMs: number = 60_000,
  ) {}

  /** 这个场所能不能开始看。已经在看的不重复进。 */
  tryEnter(venue: string, now: number = Date.now()): boolean {
    if (this.running.has(venue)) return false
    if (this.running.size >= this.maxConcurrent) return false
    this.running.add(venue)
    return true
  }

  leave(venue: string): void {
    this.running.delete(venue)
  }

  /** 现在有几个场所在跑。日志要用。 */
  size(): number {
    return this.running.size
  }

  /** 还能不能再说一句。 */
  allowSpeak(now: number = Date.now()): boolean {
    this.trim(now)
    return this.stamps.length < this.maxPerMinute
  }

  noteSpoke(now: number = Date.now()): void {
    this.trim(now)
    this.stamps.push(now)
  }

  private trim(now: number): void {
    const edge = now - this.windowMs
    while (this.stamps.length > 0 && this.stamps[0]! < edge) this.stamps.shift()
  }
}
