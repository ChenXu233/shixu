import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  accountKey,
  addAccount,
  addNote,
  parsePerson,
  readPeople,
  renderPerson,
  writePerson,
} from '../lib/people.js'

/**
 * 破损类：**同一个人的两个号被当成两个人**，或者**两个人被当成一个人**。
 * 用户看到：小号说「是我」，它一脸茫然；或者把小李的话记到老王头上。
 */
describe('它认识的人', () => {
  it('文件是人能读的：名字、账号、一行一件的事', () => {
    const person = parsePerson('# 老王\naccounts: qq:123456, qq:789012\n- 在华理读书\n- 养了只猫叫咪咪\n', 'x')
    expect(person.name).toBe('老王')
    expect(person.accounts).toEqual(['qq:123456', 'qq:789012'])
    expect(person.notes).toEqual(['在华理读书', '养了只猫叫咪咪'])
    // 写回去还是同样的形状。
    expect(renderPerson(person)).toContain('accounts: qq:123456, qq:789012')
    expect(renderPerson(person)).toContain('- 养了只猫叫咪咪')
  })

  it('账号写法统一：平台小写加冒号', () => {
    expect(accountKey('QQ', '123')).toBe('qq:123')
  })

  it('同一个人的小号能挂上去，重复的只记一次', () => {
    let person = { name: '老王', accounts: ['qq:1'], notes: [] }
    person = addAccount(person, 'qq:2', new Map([[ 'qq:1', person ]]))
    person = addAccount(person, 'qq:2', new Map([[ 'qq:1', person ]]))
    expect(person.accounts).toEqual(['qq:1', 'qq:2'])
  })

  it('别的号已经有主就不抢：两个号同名不代表同一个人', () => {
    const other = { name: '小李', accounts: ['qq:9'], notes: [] }
    const person = { name: '老王', accounts: ['qq:1'], notes: [] }
    expect(() => addAccount(person, 'qq:9', new Map([['qq:9', other]]))).toThrow()
  })

  it('重复的备注不写第二遍', () => {
    const person = addNote({ name: '老王', accounts: [], notes: ['养猫'] }, '养猫')
    expect(person.notes).toEqual(['养猫'])
  })

  it('落盘之后按账号查得回来：小号和老号指向同一个人', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shixu-people-'))
    try {
      await writePerson(dir, { name: '老王', accounts: ['qq:1', 'qq:2'], notes: ['在华理'] })
      await writePerson(dir, { name: '小李', accounts: ['qq:9'], notes: [] })

      const { byAccount } = await readPeople(dir)
      expect(byAccount.get('qq:1')?.name).toBe('老王')
      expect(byAccount.get('qq:2')?.name).toBe('老王')
      expect(byAccount.get('qq:9')?.name).toBe('小李')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
