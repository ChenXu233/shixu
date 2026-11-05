import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCore } from '../lib/memory.js'

/**
 * 破损类：**手写的记忆没进上下文** —— 写好了，它却不知道。
 */
describe('手写的 core.md', () => {
  it('写了就读得到', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shixu-core-'))
    try {
      writeFileSync(join(dir, 'core.md'), '主人叫陈旭。\n', 'utf8')
      expect(await readCore(dir)).toBe('主人叫陈旭。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没写就是空的，不是坏了', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shixu-core-'))
    try {
      expect(await readCore(dir)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
