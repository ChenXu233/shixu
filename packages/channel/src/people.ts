/**
 * 它认识的人。
 *
 * 一个人一份文件，不是一串聊天记录：`memory/people/<名字>.md`。文件头有一行
 * `accounts:`，写这个人用过的所有账号 —— 小号也是同一个人，这是这一层存在的理由。
 *
 * 格式对人友好优先：改一个人设或一条备注，用编辑器打开就能改，不需要工具。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Person {
  name: string
  /** `qq:123456` 这种「平台:用户 id」。同一个人可以有多个。 */
  accounts: string[]
  /** 关于这个人的事，一行一件。 */
  notes: string[]
}

export function peopleDir(dir: string): string {
  return join(dir, 'memory', 'people')
}

/** 账号的统一写法：平台小写，冒号分隔。 */
export function accountKey(platform: string, userId: string): string {
  return `${platform.toLowerCase()}:${userId}`
}

/** 名字当文件名，去掉路径分隔符 —— 群友的昵称里什么都可能有。 */
function fileNameOf(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]/g, '_')}.md`
}

export function parsePerson(text: string, fallbackName: string): Person {
  const lines = text.split('\n')
  const title = lines.find((one) => one.startsWith('# '))?.slice(2).trim()
  const accountsLine = lines.find((one) => one.trim().toLowerCase().startsWith('accounts:'))
  const accounts = (accountsLine ?? '')
    .slice((accountsLine ?? '').indexOf(':') + 1)
    .split(/[,，\s]+/)
    .map((one) => one.trim())
    .filter((one) => one !== '')

  const notes = lines
    .filter((one) => one.trim() !== '' && !one.startsWith('#'))
    .filter((one) => !one.trim().toLowerCase().startsWith('accounts:'))
    .map((one) => one.replace(/^[-*]\s*/, '').trim())
    .filter((one) => one !== '')

  return { name: title === undefined || title === '' ? fallbackName : title, accounts, notes }
}

export function renderPerson(person: Person): string {
  const head = [`# ${person.name}`]
  if (person.accounts.length > 0) head.push(`accounts: ${person.accounts.join(', ')}`)
  const notes = person.notes.map((one) => `- ${one}`)
  return [...head, ...notes].join('\n') + '\n'
}

/** 读出所有人：账号 → 这个人。启动时建一次，写完重建一次。 */
export async function readPeople(dir: string): Promise<{ byAccount: Map<string, Person>; byName: Map<string, Person> }> {
  const byAccount = new Map<string, Person>()
  const byName = new Map<string, Person>()
  let files: string[] = []
  try {
    files = await readdir(peopleDir(dir))
  } catch {
    return { byAccount, byName }
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue
    try {
      const text = await readFile(join(peopleDir(dir), file), 'utf8')
      const person = parsePerson(text, file.slice(0, -3))
      byName.set(person.name, person)
      for (const account of person.accounts) byAccount.set(account, person)
    } catch {
      // 读不出来的一份不挡别的：画像坏了不该让人格失忆。
    }
  }
  return { byAccount, byName }
}

export async function writePerson(dir: string, person: Person): Promise<void> {
  await mkdir(peopleDir(dir), { recursive: true })
  await writeFile(join(peopleDir(dir), fileNameOf(person.name)), renderPerson(person), 'utf8')
}

/** 往一个人的备注里加一行；重复的不写。 */
export function addNote(person: Person, note: string): Person {
  const clean = note.trim()
  if (clean === '' || person.notes.includes(clean)) return person
  return { ...person, notes: [...person.notes, clean] }
}

/** 把一个账号挂到这个人名下。已经有主的不抢 —— 那是另一个人的账号。 */
export function addAccount(person: Person, account: string, taken: Map<string, Person>): Person {
  const key = account.trim().toLowerCase()
  if (key === '') return person
  const owner = taken.get(key)
  if (owner !== undefined && owner.name !== person.name) {
    throw new Error(`账号 ${key} 已经记在 ${owner.name} 名下`)
  }
  if (person.accounts.includes(key)) return person
  return { ...person, accounts: [...person.accounts, key] }
}
