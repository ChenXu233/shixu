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

  it('判过就清空，不会几轮之后又把旧消息捞出来', () => {
    const perception = new Perception()
    perception.observe('v1', message({ id: 'a' }))
    perception.markJudged('v1', false)
    perception.observe('v1', message({ id: 'b' }))

    const state = perception.state('v1')
    expect(state?.pending.map((one) => one.id)).toEqual(['b'])
    expect(state?.recent.map((one) => one.id)).toEqual(['a', 'b'])
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

  it('缓冲有上限：只留最近的', () => {
    const perception = new Perception(3)
    for (const id of ['a', 'b', 'c', 'd']) perception.observe('v1', message({ id }))
    expect(perception.state('v1')?.recent.map((one) => one.id)).toEqual(['b', 'c', 'd'])
  })

})
