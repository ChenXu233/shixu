import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { digestPrompt, digestVenue, profilePrompt, refreshProfiles } from '../lib/digest.js'
import { Memory, memoryPath } from '../lib/store.js'

const withStore = (run: (memory: Memory) => Promise<void>) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shixu-digest-'))
  const memory = new Memory(memoryPath(dir))
  try {
    await run(memory)
  } finally {
    memory.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 破损类：**聊天越来越多，它却什么都想不起来** —— 上下文塞爆之后，只剩最近几句。
 * 用户看到：三天前聊过的事，它完全没印象。
 */
describe('把聊天压成段落', () => {
  it('压过的消息不会重复压：几次之后不会得到三段一样的话', withStore(async (memory) => {
    memory.addMessage({ id: 'm1', venue: 'v1', platform: 'qq', speakerId: 'u1', speakerName: '老王', text: '今天在华理食堂', at: 1000 })
    memory.addMessage({ id: 'm2', venue: 'v1', platform: 'qq', speakerId: 'u2', speakerName: '小李', text: '我也在', at: 2000 })

    const asked: string[] = []
    const host = { memory, ask: async (p: string) => (asked.push(p), '老王和小李在华理食堂碰上'), note: () => {} }

    await digestVenue(host, 'v1', memory.unsummarized('v1'))
    expect(memory.recentParagraphs('v1')[0]?.summary).toContain('华理')
    expect(memory.unsummarized('v1')).toHaveLength(0)

    // 再压一次：没有新消息，不该产生第二段。
    await digestVenue(host, 'v1', memory.unsummarized('v1'))
    expect(memory.recentParagraphs('v1')).toHaveLength(1)
    expect(asked).toHaveLength(1)
  }))

  it('模型没给出东西就不落库，也不标记已压', withStore(async (memory) => {
    memory.addMessage({ id: 'm1', venue: 'v1', platform: 'qq', speakerId: 'u1', text: '嗯', at: 1000 })
    const host = { memory, ask: async () => '   ', note: () => {} }
    await digestVenue(host, 'v1', memory.unsummarized('v1'))
    expect(memory.recentParagraphs('v1')).toHaveLength(0)
    expect(memory.unsummarized('v1')).toHaveLength(1)
  }))

  it('素材按时间排好，并带上说话人', () => {
    const prompt = digestPrompt([
      { id: 'm1', speaker: '老王', text: '在吗', at: 1000 },
      { id: 'm2', speaker: '小李', text: '在', at: 2000 },
    ])
    expect(prompt).toContain('老王：在吗')
    expect(prompt.indexOf('老王')).toBeLessThan(prompt.indexOf('小李'))
  })
})

describe('把事实压成画像', () => {
  it('事实够了就写一份画像', withStore(async (memory) => {
    for (const text of ['在华理读书', '养了只猫叫咪咪', '最近在准备考研']) {
      memory.addFact({ about: '老王', text, at: Date.now() })
    }
    const host = { memory, ask: async () => '华理学生，养猫，在准备考研', note: () => {} }
    await refreshProfiles(host)
    expect(memory.profileOf('老王')).toContain('考研')
  }))

  it('事实不够就不打扰模型', withStore(async (memory) => {
    memory.addFact({ about: '小李', text: '话很少', at: Date.now() })
    let called = false
    const host = { memory, ask: async () => ((called = true), 'x'), note: () => {} }
    await refreshProfiles(host)
    expect(called).toBe(false)
  }))

  it('画像提示里带上这个人所有的事实', () => {
    expect(profilePrompt('老王', ['在华理'])).toContain('- 在华理')
  })
})
