/**
 * 记忆的第二种形态：一堆可以用 git 看的 markdown。
 *
 * 库是**索引**，markdown 是**正文**。库能删了重建，因为记忆写在可以被 diff 的文件里：
 * 换台机器、回退到上周、看谁改了哪句话，用的都是 git。
 *
 * 和 MaiBot 的记忆包是一个意思（.amembundle），只是我们不用 zip，直接落成文本。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Memory } from './store.js'

export function mirrorDir(dir: string): string {
  return join(dir, 'memory', 'md')
}

/** 名字当文件名：群友的昵称里什么都可能有。 */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_')
}

const stamp = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ')

export interface MirrorCount {
  facts: number
  people: number
  paragraphs: number
}

/** 把库写回 markdown。写之前不删旧文件，靠覆盖 —— 手动改过的名字也不会突然消失。 */
export async function exportMemory(memory: Memory, dir: string): Promise<MirrorCount> {
  const root = mirrorDir(dir)
  await mkdir(join(root, 'people'), { recursive: true })
  await mkdir(join(root, 'venues'), { recursive: true })

  const facts = memory.allFacts()
  const profiles = new Map(memory.allProfiles().map((one) => [one.name, one.profile]))

  const aboutSelf = facts.filter((one) => one.about === '')
  await writeFile(
    join(root, 'facts.md'),
    ['# 它记得的事', '', ...aboutSelf.map((one) => `- [${stamp(one.at)}] ${one.text}`)].join('\n') + '\n',
    'utf8',
  )

  const people = new Map<string, typeof facts>()
  for (const fact of facts) {
    if (fact.about === '') continue
    people.set(fact.about, [...(people.get(fact.about) ?? []), fact])
  }
  for (const [name, list] of people) {
    const profile = profiles.get(name)
    const body = [
      `# ${name}`,
      ...(profile === undefined ? [] : ['', '## 画像', profile]),
      '',
      '## 记得的事',
      ...list.map((one) => `- [${stamp(one.at)}] ${one.text}`),
    ].join('\n')
    await writeFile(join(root, 'people', `${safeName(name)}.md`), body + '\n', 'utf8')
  }

  const byVenue = new Map<string, string[]>()
  for (const paragraph of memory.allParagraphs()) {
    byVenue.set(paragraph.venue, [...(byVenue.get(paragraph.venue) ?? []), `- [${stamp(paragraph.toAt)}] ${paragraph.summary}`])
  }
  for (const [venue, lines] of byVenue) {
    await writeFile(join(root, 'venues', `${safeName(venue)}.md`), [`# ${venue}`, '', ...lines].join('\n') + '\n', 'utf8')
  }

  return { facts: facts.length, people: people.size, paragraphs: memory.allParagraphs().length }
}

/**
 * 反过来：从 markdown 重建库。
 *
 * 只认我们自己写出去的那两种行：`- [时间] 内容` 是事实，`# 名字` 和 `## 画像` 定归属。
 * 手写的新行也认 —— 想直接往 markdown 里加记忆，改完重启就进库了。
 */
export async function importMemory(memory: Memory, dir: string): Promise<MirrorCount> {
  const root = mirrorDir(dir)
  let facts = 0
  let people = 0
  let paragraphs = 0

  const readIfAny = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return undefined
    }
  }

  /** `- [2026-11-05 12:00] 内容` 或手写的 `- 内容`。 */
  const parseLines = (text: string): Array<{ at: number; text: string }> =>
    text
      .split('\n')
      .filter((line) => line.trim().startsWith('- '))
      .map((line) => {
        const body = line.trim().slice(2)
        const matched = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.*)$/.exec(body)
        return matched === null
          ? { at: Date.now(), text: body }
          : { at: Date.parse(matched[1]!.replace(' ', 'T') + ':00Z') || Date.now(), text: matched[2]!.trim() }
      })
      .filter((one) => one.text !== '')

  const self = await readIfAny(join(root, 'facts.md'))
  if (self !== undefined) {
    for (const one of parseLines(self)) {
      memory.addFact({ about: '', text: one.text, at: one.at })
      facts += 1
    }
  }

  let files: string[] = []
  try {
    files = await readdir(join(root, 'people'))
  } catch {
    files = []
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const text = await readIfAny(join(root, 'people', file))
    if (text === undefined) continue
    const name = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? file.slice(0, -3)
    const profile = /##\s*画像\s*\n([\s\S]*?)(?:\n##|$)/.exec(text)?.[1]?.trim()
    if (profile !== undefined && profile !== '') memory.setProfile(name, profile)
    for (const one of parseLines(text)) {
      memory.addFact({ about: name, text: one.text, at: one.at })
      facts += 1
    }
    people += 1
  }

  let venues: string[] = []
  try {
    venues = await readdir(join(root, 'venues'))
  } catch {
    venues = []
  }
  for (const file of venues) {
    if (!file.endsWith('.md')) continue
    const text = await readIfAny(join(root, 'venues', file))
    if (text === undefined) continue
    const venue = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? file.slice(0, -3)
    for (const one of parseLines(text)) {
      memory.addParagraph({ venue, summary: one.text, fromAt: one.at, toAt: one.at, messageCount: 0 }, [])
      paragraphs += 1
    }
  }

  return { facts, people, paragraphs }
}
