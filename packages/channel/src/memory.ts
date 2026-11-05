/**
 * 它自己的记忆。
 *
 * 只有一份：`core.md`。写进去的是「它自己觉得重要、以后还想得起来的事」——
 * 不是聊天记录，也不是笔记审查。成长的前提是它有权决定记什么。
 *
 * 这里只管文件：注入提示、工具写入、长度上限。检索、分层、向量都不在这。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 记忆文件的大小上限。超了不是截断，是拒绝写入 —— 截断会悄悄丢东西。 */
export const CORE_LIMIT = 8_000

export function corePath(dir: string): string {
  return join(dir, 'core.md')
}

export async function readCore(dir: string): Promise<string> {
  try {
    return (await readFile(corePath(dir), 'utf8')).trim()
  } catch {
    return ''
  }
}

/** 原子写：先写临时文件再改名，读的人看不到半截。 */
export async function writeCore(dir: string, text: string): Promise<void> {
  const path = corePath(dir)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
  await rename(temp, path)
}

/** 追加一行。空行和重复行都不写 —— 记忆里不该有复读。 */
export function appendLine(text: string, line: string): string {
  const clean = line.trim()
  if (clean === '') return text
  const body = text.trimEnd()
  if (body.split('\n').some((one) => one.trim() === clean)) return body
  return body === '' ? clean : `${body}\n${clean}`
}

/** 把某一行换成新的。找不到就抛错 —— 静默改别的行比报错更糟。 */
export function replaceLine(text: string, from: string, to: string): string {
  const target = from.trim()
  const lines = text.split('\n')
  const index = lines.findIndex((one) => one.trim() === target)
  if (index < 0) throw new Error(`记忆里没有这一行：${target}`)
  lines[index] = to.trim()
  return lines.filter((one) => one.trim() !== '').join('\n')
}
