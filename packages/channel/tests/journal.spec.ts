import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJournal } from '../lib/journal.js'

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 破损类：**出问题的时候，现场没留下来**。
 * 用户看到：群里不回话，捂了半天也说不清为什么 —— 今天排查图片就是这么卡住的。
 */
describe('人格目录下的日志', () => {
  it('按发生顺序一行一件事，带时间与作用域', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shixu-journal-'))
    try {
      const journal = createJournal(dir)
      journal.note('boot', 'persona=default')
      journal.note('image', '下载失败：http://x/a.png')
      await wait()

      const text = await readFile(join(dir, 'logs', 'shixu.log'), 'utf8')
      const lines = text.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z boot\s+persona=default$/)
      expect(lines[1]).toContain('image')
      expect(lines[1]).toContain('下载失败：http://x/a.png')
    } finally {
      // Windows 上写盘队列可能还没落完，删目录要重试几次。
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('写满了改名成 .1 重来，不无限长', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shixu-journal-'))
    try {
      const journal = createJournal(dir, 120)
      for (let i = 0; i < 4; i += 1) journal.note('noise', 'x'.repeat(50) + i)
      await wait(150)

      const rotated = await stat(join(dir, 'logs', 'shixu.log.1'))
      expect(rotated.size).toBeGreaterThan(0)
      const current = await stat(join(dir, 'logs', 'shixu.log')).catch(() => undefined)
      expect(current === undefined || current.size <= 120).toBe(true)
    } finally {
      // Windows 上写盘队列可能还没落完，删目录要重试几次。
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('目录不存在就自己建，写不进去也不抛', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shixu-journal-'))
    try {
      const journal = createJournal(join(dir, 'persona', 'default'))
      journal.note('boot', 'ok')
      await wait()
      expect(await readFile(join(dir, 'persona', 'default', 'logs', 'shixu.log'), 'utf8')).toContain('ok')
    } finally {
      // Windows 上写盘队列可能还没落完，删目录要重试几次。
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
