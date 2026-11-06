import { describe, expect, it } from 'vitest'
import { parseVerdict, plannerPrompt } from '../lib/planner.js'

/**
 * 破损类：**它在该说话的时候沉默，在不该说话的时候插话**。
 * 用户看到：群里没叫它，它却凑上来；有人认真问问题，它反而不理。
 */
describe('判官的回话怎么读', () => {
  it('「不值得」不能被读成「值得」', () => {
    // 这是最容易写错的一处：肯定词是「值得」的子串。
    expect(parseVerdict('不值得，只是打招呼').look).toBe(false)
    expect(parseVerdict('值得：有人在问报错').look).toBe(true)
  })

  it('理由跟着判定一起回来，去掉前缀', () => {
    expect(parseVerdict('值得：有人在问报错').reason).toBe('有人在问报错')
    expect(parseVerdict('不值得，刷屏').reason).toBe('刷屏')
  })

  it('英文也认', () => {
    expect(parseVerdict('YES, someone asked a question').look).toBe(true)
    expect(parseVerdict('NO, just greetings').look).toBe(false)
  })

  it('说了别的当「不看」：判官失手时沉默比插话便宜', () => {
    expect(parseVerdict('我不确定').look).toBe(false)
    expect(parseVerdict('').look).toBe(false)
  })

  it('只看第一行，后面多余的话不参与判定', () => {
    expect(parseVerdict('值得看\n这行不该影响结果：不值得').look).toBe(true)
  })
})

describe('判官看到的输入', () => {
  it('带上人格、消息、时间参照，并且要求只回一行', () => {
    const prompt = plannerPrompt({
      persona: '时煦，一只猫娘',
      messages: [{ id: 'm1', speaker: '老王', text: '这个报错怎么修' }],
      minutesSinceSpoke: 12,
    })
    expect(prompt).toContain('时煦')
    expect(prompt).toContain('[m1] 老王：这个报错怎么修')
    expect(prompt).toContain('12 分钟前')
    expect(prompt).toContain('只回答一行')
  })
})
