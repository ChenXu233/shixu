import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { episodePrompt, rollEpisode } from '../lib/digest.js'
import { Memory, memoryPath } from '../lib/store.js'

const withStore = async (run: (memory: Memory) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'shixu-ep-'))
  const memory = new Memory(memoryPath(dir))
  try {
    await run(memory)
  } finally {
    memory.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 破损类：**它只有「刚才」，没有「那天」** —— 问它上周群里聊了什么，它答不上来。
 */
describe('情景记忆', () => {
  it('当天有段落才滚情景，一天一份', async () => {
    await withStore(async (memory) => {
      memory.addParagraph({ venue: 'v1', summary: '聊了考研', fromAt: 1, toAt: 2, messageCount: 5 }, [])
      const host = { memory, ask: async () => '大家在聊考研的事', note: () => {} }

      await rollEpisode(host, 'v1', '2026-11-05')
      expect(memory.episodeOf('v1', '2026-11-05')).toContain('考研')

      // 同一天再滚一次：覆盖，不新增第二份。
      await rollEpisode({ ...host, ask: async () => '考研聊得更细了' }, 'v1', '2026-11-05')
      expect(memory.episodeOf('v1', '2026-11-05')).toContain('更细')
    })
  })

  it('没有段落就不打扰模型', async () => {
    await withStore(async (memory) => {
      let called = false
      await rollEpisode({ memory, ask: async () => ((called = true), 'x'), note: () => {} }, 'v1', '2026-11-05')
      expect(called).toBe(false)
    })
  })

  it('提示里带上场所与日期，模型知道是哪天的事', () => {
    const prompt = episodePrompt('qq g1', '2026-11-05', ['聊了考研'])
    expect(prompt).toContain('qq g1')
    expect(prompt).toContain('2026-11-05')
    expect(prompt).toContain('- 聊了考研')
  })
})
