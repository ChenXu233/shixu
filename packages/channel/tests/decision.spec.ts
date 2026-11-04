import { describe, expect, it } from 'vitest'
import { decide, SPEAK_THRESHOLD } from '../lib/decision.js'

const base = {
  pending: 1,
  mentioned: false,
  named: false,
  isPrivate: false,
  silenceStreak: 0,
  sinceLastSpokeMs: 0,
}

/**
 * 破损类：**它在不该开口的时候开口**，或者**该接的话一句不接**。
 * 用户看到：群里没人理它，它却自顾自插话；或者聊了半天它像掉线。
 */
describe('这一批要不要接', () => {
  it('私聊必回', () => {
    expect(decide({ ...base, isPrivate: true }).act).toBe('speak')
  })

  it('被 @ 必回，不看分数', () => {
    const decision = decide({ ...base, mentioned: true, silenceStreak: 9 })
    expect(decision.act).toBe('speak')
    expect(decision.reasons).toContain('被 @')
  })

  it('提到名字也回 —— 群里没人会一直 @ 你', () => {
    expect(decide({ ...base, named: true }).act).toBe('speak')
  })

  it('没人叫它、也没人提它：默认沉默', () => {
    expect(decide({ ...base, pending: 1 }).act).toBe('silence')
  })

  it('攒够一批消息才够格开口', () => {
    // 阈值 2：四条起步的积压刚好够，三条不够。
    expect(decide({ ...base, pending: 3 }).act).toBe('silence')
    expect(decide({ ...base, pending: 4 }).act).toBe('speak')
  })

  it('连着沉默会越来越难开口（backoff）', () => {
    const fresh = decide({ ...base, pending: 4 })
    const tired = decide({ ...base, pending: 4, silenceStreak: 3 })
    expect(fresh.act).toBe('speak')
    expect(tired.act).toBe('silence')
    expect(tired.score).toBeLessThan(fresh.score)
  })

  it('沉默惩罚有上限：连着不说话是常态，不能因此永远闭嘴', () => {
    const tired = decide({ ...base, pending: 4, silenceStreak: 3 })
    const exhausted = decide({ ...base, pending: 4, silenceStreak: 99 })
    expect(exhausted.score).toBe(tired.score)
    // 攒够热度仍然能开口。
    expect(decide({ ...base, pending: 12, silenceStreak: 99 }).act).toBe('speak')
  })

  it('很久没在这个场所说过话，分更高（neglectedness）', () => {
    const recent = decide({ ...base, pending: 2, sinceLastSpokeMs: 0 })
    const neglected = decide({ ...base, pending: 2, sinceLastSpokeMs: 600_000 })
    expect(neglected.score).toBeGreaterThan(recent.score)
  })

  it('从没在这个场所说过话，不算「久未开口」', () => {
    // 否则它一进群就想插嘴：只要来一条没叫它的消息就够分。
    expect(decide({ ...base, pending: 1, sinceLastSpokeMs: 0 }).act).toBe('silence')
  })

  it('阈值只有一个出处', () => {
    expect(SPEAK_THRESHOLD).toBe(2)
  })
})
