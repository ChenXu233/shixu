/**
 * 一个库，全世界的记忆。
 *
 * 照 MaiBot 的 A_Memorix 抄的形状：原始消息、事实账本、实体、关系、画像、全文索引。
 * 唯一改掉的是**作用域**：它是按群分割的，我们是全局一份 —— 一个人格在三个群里
 * 听到的事，本来就该是同一段记忆。
 *
 * 没有 accounts 表：「老王的另一个号是 123」是一条事实，模型自己在画像里连。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface StoredMessage {
  id: string
  venue: string
  platform: string
  speakerId: string
  speakerName?: string
  text: string
  at: number
  platformMessageId?: string
}

export interface Fact {
  id: string
  /** 关于谁：人名；空字符串表示「它自己」。 */
  about: string
  text: string
  venue?: string
  sourceMessageId?: string
  at: number
}

export interface Hit {
  kind: 'message' | 'fact'
  ref: string
  body: string
  at: number
  venue?: string
}

export function memoryPath(dir: string): string {
  return join(dir, 'memory', 'memory.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  platform TEXT NOT NULL,
  speaker_id TEXT NOT NULL,
  speaker_name TEXT,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  platform_message_id TEXT,
  summarized INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_venue_at ON messages(venue, at);

-- 一段对话压成一段话。messages.summarized 标记它已经被压进去了。
CREATE TABLE IF NOT EXISTS paragraphs (
  id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  summary TEXT NOT NULL,
  from_at INTEGER NOT NULL,
  to_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS paragraphs_venue_at ON paragraphs(venue, to_at);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  about TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  venue TEXT,
  source_message_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_about ON facts(about, at);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '',
  refreshed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS entities_name ON entities(name);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  label TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- trigram 分词：中文没有空格，默认分词会把整句当一个词，搜不到。
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(body, kind UNINDEXED, ref UNINDEXED, tokenize='trigram');
`

/** 攒够这么多条没压过的消息，就值得压一段了。 */
export const DIGEST_EVERY = 20

export interface Paragraph {
  id: string
  venue: string
  summary: string
  fromAt: number
  toAt: number
  messageCount: number
}

export class Memory {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
  }

  /** 每条消息都落库：不落库的东西，以后都查不到。 */
  addMessage(message: StoredMessage): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO messages (id, venue, platform, speaker_id, speaker_name, text, at, platform_message_id) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        message.id,
        message.venue,
        message.platform,
        message.speakerId,
        message.speakerName ?? null,
        message.text,
        message.at,
        message.platformMessageId ?? null,
      )
    this.index('message', message.id, `${message.speakerName ?? message.speakerId}：${message.text}`)
  }

  addFact(fact: Omit<Fact, 'id'> & { id?: string }): Fact {
    const id = fact.id ?? `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.db
      .prepare('INSERT INTO facts (id, about, text, venue, source_message_id, at) VALUES (?,?,?,?,?,?)')
      .run(id, fact.about, fact.text, fact.venue ?? null, fact.sourceMessageId ?? null, fact.at)
    this.index('fact', id, fact.about === '' ? fact.text : `${fact.about}：${fact.text}`)
    return { ...fact, id }
  }

  /** 实体是「人 / 东西 / 话题」，画像挂在它身上。 */
  upsertEntity(kind: 'person' | 'thing' | 'topic', name: string): void {
    this.db
      .prepare('INSERT INTO entities (id, kind, name) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING')
      .run(`e-${name}`, kind, name)
  }

  setProfile(name: string, profile: string): void {
    this.upsertEntity('person', name)
    this.db
      .prepare('UPDATE entities SET profile = ?, refreshed_at = ? WHERE name = ?')
      .run(profile, Date.now(), name)
  }

  profileOf(name: string): string | undefined {
    const row = this.db.prepare('SELECT profile FROM entities WHERE name = ?').get(name) as
      | { profile?: string }
      | undefined
    const profile = row?.profile?.trim()
    return profile === undefined || profile === '' ? undefined : profile
  }

  /** 全局检索：一个群里学到的东西，在另一个群里也查得到。 */
  search(query: string, limit = 10): Hit[] {
    const clean = query.trim()
    if (clean === '') return []
    // trigram 至少三个字符才建索引；短词退回 LIKE，宁可慢也别查不到。
    const sql =
      clean.length >= 3
        ? 'SELECT body, kind, ref FROM search WHERE search MATCH ? LIMIT ?'
        : 'SELECT body, kind, ref FROM search WHERE body LIKE ? LIMIT ?'
    const rows = this.db.prepare(sql).all(clean.length >= 3 ? clean : `%${clean}%`, limit) as Array<{
      body: string
      kind: string
      ref: string
    }>

    return rows.map((row) => {
      if (row.kind === 'fact') {
        const fact = this.db.prepare('SELECT at, venue FROM facts WHERE id = ?').get(row.ref) as
          | { at?: number; venue?: string }
          | undefined
        return { kind: 'fact' as const, ref: row.ref, body: row.body, at: fact?.at ?? 0, venue: fact?.venue }
      }
      const message = this.db.prepare('SELECT at, venue FROM messages WHERE id = ?').get(row.ref) as
        | { at?: number; venue?: string }
        | undefined
      return { kind: 'message' as const, ref: row.ref, body: row.body, at: message?.at ?? 0, venue: message?.venue }
    })
  }

  /** 这个场所还没被压进段落的消息，按时间顺序。 */
  unsummarized(venue: string, limit = DIGEST_EVERY * 2): Array<{ id: string; speaker: string; text: string; at: number }> {
    return this.db
      .prepare(
        'SELECT id, COALESCE(speaker_name, speaker_id) AS speaker, text, at FROM messages WHERE venue = ? AND summarized = 0 ORDER BY at ASC LIMIT ?',
      )
      .all(venue, limit) as unknown as Array<{ id: string; speaker: string; text: string; at: number }>
  }

  /** 压好一段：段落落库，来源消息标记已压，免得下一轮重复压。 */
  addParagraph(paragraph: Omit<Paragraph, 'id'> & { id?: string }, messageIds: readonly string[]): Paragraph {
    const id = paragraph.id ?? `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.db
      .prepare(
        'INSERT INTO paragraphs (id, venue, summary, from_at, to_at, message_count, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, paragraph.venue, paragraph.summary, paragraph.fromAt, paragraph.toAt, paragraph.messageCount, Date.now())
    const mark = this.db.prepare('UPDATE messages SET summarized = 1 WHERE id = ?')
    for (const messageId of messageIds) mark.run(messageId)
    this.index('paragraph', id, paragraph.summary)
    return { ...paragraph, id }
  }

  /** 该刷新画像的人：facts 够多但画像还空着（或很久没更新）。 */
  dueProfiles(limit = 2, minFacts = 3): Array<{ name: string; facts: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT about AS name, COUNT(*) AS n FROM facts
         WHERE about != '' GROUP BY about HAVING n >= ?
         AND about NOT IN (SELECT name FROM entities WHERE profile != '' AND refreshed_at > ?)
         LIMIT ?`,
      )
      .all(minFacts, Date.now() - 6 * 60 * 60_000, limit) as unknown as Array<{ name: string; n: number }>

    return rows.map((row) => ({
      name: row.name,
      facts: this.recentFacts(row.name, 12).map((one) => one.text),
    }))
  }

  recentParagraphs(venue: string, limit = 3): Paragraph[] {
    const rows = this.db
      .prepare(
        'SELECT id, venue, summary, from_at AS fromAt, to_at AS toAt, message_count AS messageCount FROM paragraphs WHERE venue = ? ORDER BY to_at DESC LIMIT ?',
      )
      .all(venue, limit) as unknown as Paragraph[]
    return rows
  }

  allFacts(): Fact[] {
    return this.db.prepare('SELECT id, about, text, venue, source_message_id AS sourceMessageId, at FROM facts ORDER BY at ASC').all() as unknown as Fact[]
  }

  allParagraphs(): Paragraph[] {
    return this.db
      .prepare('SELECT id, venue, summary, from_at AS fromAt, to_at AS toAt, message_count AS messageCount FROM paragraphs ORDER BY to_at ASC')
      .all() as unknown as Paragraph[]
  }

  allProfiles(): Array<{ name: string; profile: string }> {
    return this.db.prepare("SELECT name, profile FROM entities WHERE profile != ''").all() as unknown as Array<{ name: string; profile: string }>
  }

  recentFacts(about: string, limit = 5): Fact[] {
    return this.db
      .prepare('SELECT * FROM facts WHERE about = ? ORDER BY at DESC LIMIT ?')
      .all(about, limit) as unknown as Fact[]
  }

  private index(kind: string, ref: string, body: string): void {
    this.db.prepare('INSERT INTO search (body, kind, ref) VALUES (?,?,?)').run(body, kind, ref)
  }

  close(): void {
    this.db.close()
  }
}
