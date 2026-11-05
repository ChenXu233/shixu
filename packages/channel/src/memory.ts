/**
 * 手写的那份记忆。
 *
 * `core.md` 是主人（或它自己）用编辑器写的：关于它自己、关于主人的稳定事实。
 * 它是**人写的文本**，所以不提供写入工具 —— 它自己记的东西走数据库（`store.ts`）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
