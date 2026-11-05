import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendLine, readCore, replaceLine, writeCore } from '../lib/memory.js'

/**
 * 破损类：**它记不住事，或者记住的是一堆复读**。
 * 用户看到：聊了三天它还问「你叫什么」；或者记忆里同一句话存了二十遍。
 */
describe('它自己的记忆', () => {
  it('没有记忆文件就是空的，不是坏了', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shixu-core-'))
    try {
      expect(await readCore(dir)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('写进去能读回来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shixu-core-'))
    try {
      await writeCore(dir, '主人叫陈旭。')
      expect(await readCore(dir)).toBe('主人叫陈旭。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('追加不写重复的：同一句话记二十遍不叫记住', () => {
    const once = appendLine('', '主人叫陈旭。')
    const twice = appendLine(once, '主人叫陈旭。')
    expect(twice).toBe('主人叫陈旭。')
    expect(appendLine(once, '他养了只猫。')).toBe('主人叫陈旭。\n他养了只猫。')
  })

  it('改一行要精确命中：记错了能改，不是再记一遍', () => {
    expect(replaceLine('a\nb', 'b', 'c')).toBe('a\nc')
    expect(() => replaceLine('a', '没有这行', 'x')).toThrow()
  })

})
