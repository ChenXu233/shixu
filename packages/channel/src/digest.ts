/**
 * 把聊天压成一段话，把事实压成一份画像。
 *
 * 两件事共用同一条路径：找一个「摘要会话」（不在任何场所里，用同一份人格和模型），
 * 把素材丢过去，只让它回摘要。摘要会话是独立会话，不占场所的上下文。
 *
 * 抽在这里是为了能测：ask 是注入的，测试里给它一个假的模型。
 */
import type { Memory } from './store.js'

export interface DigestHost {
  memory: Memory
  /** 让摘要会话回答一段话。 */
  ask(prompt: string): Promise<string>
  note(text: string): void
}

export interface DigestRow {
  id: string
  speaker: string
  text: string
  at: number
}

/** 一两句话的摘要提示。素材是最近这一批没压过的消息。 */
export function digestPrompt(rows: readonly DigestRow[]): string {
  const lines = rows.map((one) => {
    const when = new Date(one.at).toISOString().slice(11, 16)
    return `[${when}] ${one.speaker}：${one.text}`
  })
  return [
    '把下面这段聊天压成两三句话：谁在聊什么、有没有值得记住的事。',
    '只输出摘要本身，不要客套，不要逐条复述，不要分析。',
    '',
    ...lines,
  ].join('\n')
}

export function profilePrompt(name: string, facts: readonly string[]): string {
  return [
    `下面是关于「${name}」的事实，用两三句话写一份画像：他是谁、在意什么、最近在做什么。`,
    '只输出画像本身，不要客套。',
    '',
    ...facts.map((one) => `- ${one}`),
  ].join('\n')
}

/** 压这一段，落库，标记来源已压。返回摘要；模型没给出东西就不落库。 */
export async function digestVenue(host: DigestHost, venue: string, rows: readonly DigestRow[]): Promise<string> {
  if (rows.length === 0) return ''
  const summary = (await host.ask(digestPrompt(rows))).trim()
  if (summary === '') return ''

  host.memory.addParagraph(
    {
      venue,
      summary,
      fromAt: rows[0]!.at,
      toAt: rows[rows.length - 1]!.at,
      messageCount: rows.length,
    },
    rows.map((one) => one.id),
  )
  host.note(`段落 ${venue}：${rows.length} 条 → ${summary.length} 字`)
  return summary
}

/** 该刷新的人挨个刷一遍；一轮最多几个，由 store 决定。 */
export async function refreshProfiles(host: DigestHost, limit = 2): Promise<void> {
  for (const person of host.memory.dueProfiles(limit)) {
    const profile = (await host.ask(profilePrompt(person.name, person.facts))).trim()
    if (profile === '') continue
    host.memory.setProfile(person.name, profile)
    host.note(`画像 ${person.name}：${profile.length} 字`)
  }
}
