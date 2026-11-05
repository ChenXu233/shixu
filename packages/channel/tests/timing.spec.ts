import { describe, expect, it } from 'vitest'
import { MAX_DELAY_MS, splitReply, typingDelay } from '../lib/timing.js'

/**
 * 破损类：**一看就是机器人**。
 * 用户看到：问一句，半秒不到回一大段；或者一条回复被拆成八条轰炸。
 */
describe('等多久再发', () => {
  it('字越多等得越久，但单条有上限', () => {
    const short = typingDelay('在', 600, () => 0.5)
    const long = typingDelay('这是一句很长的话'.repeat(100), 600, () => 0.5)
    expect(long).toBeGreaterThan(short)
    expect(long).toBeLessThanOrEqual(MAX_DELAY_MS)
  })

  it('同样的内容不是每次都等一样久', () => {
    const quick = typingDelay('你好', 600, () => 0)
    const slow = typingDelay('你好', 600, () => 1)
    expect(slow).toBeGreaterThan(quick)
  })
})

describe('切成几条', () => {
  it('短回复不切', () => {
    expect(splitReply('好的')).toEqual(['好的'])
  })

  it('长回复按句子切，最多三条', () => {
    const text = '第一句。第二句。第三句。第四句。第五句。第六句。'
    const chunks = splitReply(text, 3)
    expect(chunks).toHaveLength(3)
    expect(chunks.join('')).toBe(text)
  })

  it('关掉切分就是原样一条', () => {
    const text = '第一句。第二句。'
    expect(splitReply(text, 0)).toEqual([text])
  })

  it('没有句号的一大段不硬切', () => {
    const text = '一口气说很长很长很长很长的话没有标点'
    expect(splitReply(text, 3)).toEqual([text])
  })

  it('换行也当断句', () => {
    const chunks = splitReply('第一段\n第二段\n第三段\n第四段', 2)
    expect(chunks).toHaveLength(2)
  })
})
