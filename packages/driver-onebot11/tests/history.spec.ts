import { describe, expect, it } from 'vitest'
import { normalizeHistory } from '../lib/protocol.js'

/**
 * 破损类：**模型拿到一坨平台报文，不知道谁说了什么、更不知道 message_id**。
 * 用户看到：让它「引用刚才那句」，它引不出来，或者答非所问。
 */
describe('历史消息归一化', () => {
  it('留下 id、谁、说了什么、什么时候', () => {
    const out = normalizeHistory({
      messages: [
        {
          message_id: 12345,
          time: 1700000000,
          sender: { user_id: 42, nickname: '小王', card: '老王' },
          message: [
            { type: 'text', data: { text: '这个报错怎么修' } },
            { type: 'image', data: { file: 'x.jpg' } },
          ],
        },
      ],
    })

    expect(out).toEqual([
      { id: '12345', sender: '42', name: '老王', text: '这个报错怎么修[图片]', at: 1700000000000 },
    ])
  })

  it('没有 message_id 的消息直接丢：引用不了的东西不该进上下文', () => {
    expect(normalizeHistory({ messages: [{ sender: { user_id: 1 }, message: [] }] })).toEqual([])
  })

  it('不是 { messages: [...] } 就返回空，不抛', () => {
    expect(normalizeHistory(undefined)).toEqual([])
    expect(normalizeHistory({ data: [] })).toEqual([])
  })

  it('字符串形式的消息也认', () => {
    const out = normalizeHistory({ messages: [{ message_id: 1, time: 1, message: '纯文本' }] })
    expect(out[0]?.text).toBe('纯文本')
  })
})
