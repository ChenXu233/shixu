import { describe, expect, it } from 'vitest'
import { decide, gaps, MIN_GAP_MS, QUIET_GAP_MS } from '../lib/decision.js'

const base = {
  pending: 1,
  mentioned: false,
  named: false,
  isPrivate: false,
  sinceLastVisitMs: 10 * 60_000,
  sinceLastMessageMs: 5_000,
  talkValue: 1,
  silenceStreak: 0,
}

/**
 * 破损类：**该看一眼的时候不去看，或者一直盯着不放**。
 * 用户看到：群里没人叫它它也不来；或者每隔一分钟冒一次泡。
 */
describe('要不要去看一眼', () => {
  it('私聊、被 @、被叫名字：马上看', () => {
    expect(decide({ ...base, isPrivate: true }).act).toBe('visit')
    expect(decide({ ...base, mentioned: true }).act).toBe('visit')
    expect(decide({ ...base, named: true }).act).toBe('visit')
  })

  it('刚看过就别盯着', () => {
    expect(decide({ ...base, pending: 9, sinceLastVisitMs: MIN_GAP_MS - 1 }).act).toBe('silence')
  })

  it('有人在聊就去看：两条以上', () => {
    expect(decide({ ...base, pending: 2 }).act).toBe('visit')
    expect(decide({ ...base, pending: 1 }).act).toBe('silence')
  })

  it('安静久了回去看看：没人说话也要醒一次', () => {
    const quiet = { ...base, pending: 0, sinceLastMessageMs: QUIET_GAP_MS + 1 }
    const decision = decide(quiet)
    expect(decision.act).toBe('visit')
    expect(decision.reasons[0]).toContain('安静')
  })

  it('不吵不静，就不去', () => {
    expect(decide({ ...base, sinceLastMessageMs: 60_000 }).act).toBe('silence')
  })

  it('话少的人格：安静很久也不急着去', () => {
    // talkValue 0.3：安静间隔变成三倍多，半小时不够。
    expect(decide({ ...base, talkValue: 0.3, pending: 0, sinceLastMessageMs: QUIET_GAP_MS + 1 }).act).toBe('silence')
  })

  it('连着没反应就更慢：别越没反应越勤快', () => {
    const tired = gaps(1, 5)
    expect(tired.quietGap).toBeGreaterThan(QUIET_GAP_MS)
    expect(decide({ ...base, silenceStreak: 5, pending: 0, sinceLastMessageMs: QUIET_GAP_MS + 1 }).act).toBe('silence')
  })
})
