/**
 * 出错的现场，得留得下来。
 *
 * DSH 的 `ctx.logger` 写不到容器日志里 —— 排查图片那次只能临时往文件里写。
 * 所以我们自己留一份：人格目录下 `logs/shixu.log`，一行一件事，出问题直接看。
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 超过这个大小就改名成 `.1`，从头再写。够一个人格写很久。 */
export const JOURNAL_LIMIT = 1024 * 1024

export interface Journal {
  /** 记一行。写盘失败不抛：日志坏了不该让消息也坏。 */
  note(scope: string, text: string): void
}

/**
 * 开一个日志口。写入串行排队，保证顺序跟发生顺序一致。
 */
export function createJournal(dir: string, limit: number = JOURNAL_LIMIT): Journal {
  const folder = join(dir, 'logs')
  const file = join(folder, 'shixu.log')
  let queue: Promise<void> = Promise.resolve()

  const write = async (line: string): Promise<void> => {
    await mkdir(folder, { recursive: true })
    await appendFile(file, line, 'utf8')
    const info = await stat(file).catch(() => undefined)
    if (info !== undefined && info.size > limit) await rename(file, `${file}.1`).catch(() => undefined)
  }

  return {
    note(scope, text) {
      const line = `${new Date().toISOString()} ${scope.padEnd(9)} ${text}\n`
      queue = queue.then(() => write(line)).catch(() => undefined)
    },
  }
}
