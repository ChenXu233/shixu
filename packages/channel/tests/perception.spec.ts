import { describe, expect, it } from 'vitest'
import { Perception } from '../lib/perception.js'

const message = (over: Partial<Parameters<Perception['observe']>[1]> = {}) => ({
  id: 'm1',
  subject: 'u1',
  name: '小明',
  text: '在吗',
  images: 0,
  at: 1000,
  ...over,
})

/**
 * 破损类：**它对群里发生的事一无所知**。
 * 用户看到：群里聊了半小时，它一句也没接上；或者反过来，判过的旧账被反复翻出来。
 */
describe('听见了什么', () => {
  it('没被判过的消息攒在 pending 里', () => {
    const perception = new Perception()
    perception.observe('v1', message({ id: 'a' }))
    perception.observe('v1', message({ id: 'b' }))
    expect(perception.state('v1')?.pending.map((one) => one.id)).toEqual(['a', 'b'])
  })

  it('没去看就把消息留着：慢节奏的群五分钟攒不下两条，清了永远凑不齐', () => {
    const perception = new Perception()
    perception.observe('v1', message({ id: 'a' }))
    perception.markJudged('v1', false)
    expect(perception.state('v1')?.pending.map((one) => one.id)).toEqual(['a'])

    perception.observe('v1', message({ id: 'b' }))
    perception.markJudged('v1', true)
    expect(perception.state('v1')?.pending).toEqual([])
    // 看过的不会再被翻出来。
    expect(perception.state('v1')?.recent.map((one) => one.id)).toEqual(['a', 'b'])
  })

  it('连着沉默会累计，开口一次就归零', () => {
    const perception = new Perception()
    perception.observe('v1', message({ id: 'a' }))
    perception.markJudged('v1', false)
    perception.markJudged('v1', false)
    expect(perception.state('v1')?.silenceStreak).toBe(2)

    perception.markJudged('v1', true, 5000)
    const state = perception.state('v1')
    expect(state?.silenceStreak).toBe(0)
    expect(state?.lastSpokeAt).toBe(5000)
  })

  it('记下第一次听见它的时刻，之后不被覆盖', () => {
    const perception = new Perception()
    perception.observe('v1', message({ id: 'a', at: 1000 }))
    perception.observe('v1', message({ id: 'b', at: 9000 }))
    expect(perception.state('v1')?.firstSeenAt).toBe(1000)
  })

  it('判成沉默不算「看过」：否则热闹的群永远轮不到下一次', () => {
    const perception = new Perception()
    perception.observe('v1', message({ id: 'a' }))
    perception.markJudged('v1', false, 1000)
    expect(perception.state('v1')?.lastVisitAt).toBe(0)

    perception.markJudged('v1', true, 2000)
    expect(perception.state('v1')?.lastVisitAt).toBe(2000)
  })

  it('缓冲有上限：只留最近的', () => {
    const perception = new Perception(3)
    for (const id of ['a', 'b', 'c', 'd']) perception.observe('v1', message({ id }))
    expect(perception.state('v1')?.recent.map((one) => one.id)).toEqual(['b', 'c', 'd'])
  })

  it('未读也有上限：判不过来时丢最旧的，不能让历史压死', () => {
    const perception = new Perception(3)
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      perception.observe('v1', message({ id }))
      perception.markJudged('v1', false)
    }
    // 判成沉默不清空，但也不能无限涨。
    expect(perception.state('v1')?.pending.map((one) => one.id)).toEqual(['c', 'd', 'e'])
  })

})
