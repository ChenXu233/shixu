import { describe, expect, it } from 'vitest'
import { venueKey, venueKeyOf, type UnifiedEvent } from '../lib/contracts.js'

/**
 * 破损类：**同一个会话被当成两个**，或**两个会话被当成一个**。
 * 用户看到：同一个群里人格有两套记忆与在场状态；或 A 群的消息跑进 B 群。
 * venueKey 的全部职责就是把会话钉成一把稳定的键，所以只测它的边界。
 */
describe('venueKey：会话的身份', () => {
  it('没有线程时就是三段', () => {
    expect(venueKey({ platform: 'qq', accountId: 'bot', conversationId: 'g1' })).toBe('qq:bot:g1')
  })

  it('有线程时多一段，且不与兄弟线程撞键', () => {
    const a = venueKey({ platform: 'qq', accountId: 'bot', conversationId: 'g1', threadId: 't1' })
    const b = venueKey({ platform: 'qq', accountId: 'bot', conversationId: 'g1', threadId: 't2' })
    expect(a).toBe('qq:bot:g1:t1')
    expect(a).not.toBe(b)
  })

  it('空线程等于没有线程', () => {
    expect(venueKey({ platform: 'qq', accountId: 'bot', conversationId: 'g1', threadId: '' }))
      .toBe('qq:bot:g1')
  })

  it('事件挂在场所上：说话与入群落在同一个键', () => {
    const venue = { platform: 'qq', accountId: 'bot', conversationId: 'g1' }
    const said = { id: 'e1', type: 'message', venue, conversationType: 'group', timestamp: 1, self: false, raw: null } as UnifiedEvent
    const joined = { ...said, id: 'e2', type: 'member', change: 'join' } as UnifiedEvent
    expect(venueKeyOf(said)).toBe('qq:bot:g1')
    expect(venueKeyOf(joined)).toBe('qq:bot:g1')
  })
})
