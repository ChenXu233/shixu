import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportMemory, importMemory, mirrorDir } from '../lib/mirror.js'
import { Memory, memoryPath } from '../lib/store.js'

const withDir = async (run: (dir: string, memory: Memory) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), 'shixu-mirror-'))
  const memory = new Memory(memoryPath(dir))
  try {
    await run(dir, memory)
  } finally {
    memory.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 破损类：**记忆只能待在一个二进制文件里** —— 换台机器带不走，改错了退不回。
 * 用户看到：人格目录 clone 下来，它的记忆是空的。
 */
describe('记忆落成可以 git 的文本', () => {
  it('事实、画像、段落都写成 markdown', async () => {
    await withDir(async (dir, memory) => {
      memory.addFact({ about: '', text: '主人叫陈旭', at: Date.parse('2026-11-05T04:00:00Z') })
      memory.addFact({ about: '老王', text: '在华理读书', at: Date.parse('2026-11-05T05:00:00Z') })
      memory.setProfile('老王', '华理学生，养了只猫')
      memory.addParagraph({ venue: 'qq:1:g1', summary: '聊了考研', fromAt: 1, toAt: 2, messageCount: 3 }, [])

      const count = await exportMemory(memory, dir)
      expect(count.facts).toBe(2)

      const facts = readFileSync(join(mirrorDir(dir), 'facts.md'), 'utf8')
      expect(facts).toContain('主人叫陈旭')
      expect(facts).toContain('[2026-11-05 04:00]')

      const person = readFileSync(join(mirrorDir(dir), 'people', '老王.md'), 'utf8')
      expect(person).toContain('## 画像')
      expect(person).toContain('华理学生')
      expect(person).toContain('在华理读书')

      const venue = readFileSync(join(mirrorDir(dir), 'venues', 'qq_1_g1.md'), 'utf8')
      expect(venue).toContain('聊了考研')
    })
  })

  it('换个空库也能从文本重建：clone 下来不是空记忆', async () => {
    let exported: { name: string; profile?: string } | undefined
    await withDir(async (dir, memory) => {
      memory.addFact({ about: '老王', text: '在华理读书', at: Date.now() })
      memory.setProfile('老王', '华理学生')
      await exportMemory(memory, dir)

      // 模拟换机器：新的空库，从同一份目录导入。
      const fresh = new Memory(memoryPath(join(dir, 'other')))
      try {
        const count = await importMemory(fresh, dir)
        expect(count.facts).toBeGreaterThan(0)
        exported = { name: '老王', profile: fresh.profileOf('老王') }
        expect(fresh.profileOf('老王')).toContain('华理')
        expect(fresh.search('华理').length).toBeGreaterThan(0)
      } finally {
        fresh.close()
      }
    })
    expect(exported?.name).toBe('老王')
  })

  it('手写的新行也认：直接往 markdown 里加一条，重启就进库', async () => {
    await withDir(async (dir) => {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(join(mirrorDir(dir), 'people'), { recursive: true })
      writeFileSync(join(mirrorDir(dir), 'people', '小李.md'), '# 小李\n\n## 记得的事\n- 话很少\n', 'utf8')

      const fresh = new Memory(memoryPath(join(dir, 'third')))
      try {
        await importMemory(fresh, dir)
        expect(fresh.recentFacts('小李').map((one) => one.text)).toContain('话很少')
      } finally {
        fresh.close()
      }
    })
  })
})
