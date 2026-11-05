import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Memory, memoryPath } from '../lib/store.js'

const withStore = (run: (memory: Memory, dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'shixu-mem-'))
  const memory = new Memory(memoryPath(dir))
  try {
    run(memory, dir)
  } finally {
    memory.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const message = (over: Partial<Parameters<Memory['addMessage']>[0]> = {}) => ({
  id: 'm1',
  venue: 'qq:1:g1',
  platform: 'qq',
  speakerId: 'u1',
  speakerName: '老王',
  text: '今天在华理食堂吃饭',
  at: 1000,
  ...over,
})

/**
 * 破损类：**换一个群就不认识人了**，或者**想查以前说过的事查不到**。
 * 用户看到：它记得 A 群聊过的话题，到了 B 群却像失忆。
 */
describe('一个库，全局的记忆', () => {
  it('A 群说过的话，在 B 群查得到', () => {
    withStore((memory) => {
      memory.addMessage(message({ id: 'm1', venue: 'qq:1:g1', text: '老王的猫叫咪咪' }))
      // 换一个场所查：MaiBot 默认按群隔离，我们不是。
      const hits = memory.search('咪咪')
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0]?.body).toContain('咪咪')
      expect(hits[0]?.venue).toBe('qq:1:g1')
    })
  })

  it('中文按字面能搜到：不是按空格分词', () => {
    withStore((memory) => {
      memory.addMessage(message({ text: '周末去华理图书馆自习' }))
      expect(memory.search('图书馆').length).toBeGreaterThan(0)
      expect(memory.search('华理图').length).toBeGreaterThan(0)
    })
  })

  it('短词也查得到，宁可慢一点', () => {
    withStore((memory) => {
      memory.addMessage(message({ text: '老王说他要来' }))
      expect(memory.search('老王').length).toBeGreaterThan(0)
    })
  })

  it('事实和消息一起被搜出来，各自带来源', () => {
    withStore((memory) => {
      memory.addFact({ about: '老王', text: '在华理读书', at: 2000, venue: 'qq:1:g1' })
      const hits = memory.search('华理')
      const kinds = hits.map((one) => one.kind)
      expect(kinds).toContain('fact')
      expect(hits.find((one) => one.kind === 'fact')?.ref).toMatch(/^f-/)
    })
  })

  it('画像挂在人身上，读得回来', () => {
    withStore((memory) => {
      memory.setProfile('老王', '在华理读书，养了只猫叫咪咪')
      expect(memory.profileOf('老王')).toContain('咪咪')
      expect(memory.profileOf('没这个人')).toBeUndefined()
    })
  })

  it('最近的事实按时间倒序，最近说的先看到', () => {
    withStore((memory) => {
      memory.addFact({ about: '老王', text: '早先的事', at: 1000 })
      memory.addFact({ about: '老王', text: '刚说的事', at: 5000 })
      expect(memory.recentFacts('老王').map((one) => one.text)).toEqual(['刚说的事', '早先的事'])
    })
  })
})
