/**
 * 人格的配置面。
 *
 * 只有四件事无法从别处推出：
 *   1. 它是谁 —— `personaId`，决定人设、记忆、产物落在哪个目录；
 *   2. 用哪个脑子 —— `provider` / `model` / `reasoningEffort`，都留空表示跟随部署默认；
 *   3. 在哪些场所安静 —— `mutedVenues`，默认哪里都在场，列进去的场所不回应；
 *   4. 数据放哪 —— 由 `DSH_HOME` 推出，不做成字段。
 *
 * 其余全是派生：会话 id 由场所键算出（`shixu-<venueKey>`），cwd 是人格根，
 * 记忆与产物在人格根下。加字段之前先问一句：这个值能不能从别处算出来？
 *
 * 字段的落盘位置仍是 profile patch 里那一行的 config；这里只是它的形状，
 * 给 host 与设置页看。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  // 人格的标识，同时是数据目录名。一个部署可以有很多人格，现在只有默认那一个。
  personaId: z.string().default('default'),
  // 别人可能用来叫它的名字。群里没 @、但打了名字，也算在叫它。
  aliasNames: z.array(z.string()).default([]).volatile(),
  // 攒多久再判一次「要不要接话」（毫秒）。太短等于一条一判，太长会错过话头。
  judgeWindowMs: z.number().default(3000).volatile(),
  // 说话多少的总量旋钮：越小越安静，1 = 正常。核心影响两条时间线的长短。
  talkValue: z.number().default(1).volatile(),
  // 注意力模式：shadow 只记日志（默认），live 真叫醒它去看。
  attention: z.string().default('shadow').volatile(),
  // 判官（Planner）用哪个模型：留空 = 跟随部署默认。将来接 JEV 这类小模型就填在这里。
  plannerModel: z.string().default('').volatile(),
  // 同时最多看几个场所；每分钟总共最多说几句。
  maxConcurrent: z.number().default(3).volatile(),
  maxPerMinute: z.number().default(8).volatile(),
  // 发消息前的基础停顿（毫秒）。0 = 不模拟打字，立刻发。
  typingDelayMs: z.number().default(600).volatile(),
  // 一条回复最多拆成几条发。0 或 1 = 不拆。
  replyMaxChunks: z.number().default(3).volatile(),
  // 回复要不要引用原消息：`never`（默认）/ `when-older`（答的不是最新那条时）/ `always`。
  // 真人不是每句都引用 —— 这是「像不像人」的一部分，所以交给主人定，不写死在代码里。
  quote: z.string().default('never').volatile(),
  // 模型三件套：留空 = 跟随部署默认（设置页里那个默认模型）。
  provider: z.string().volatile(),
  model: z.string().volatile(),
  reasoningEffort: z.string().volatile(),
  // 安静的场所。空 = 哪里都在场。
  mutedVenues: z.array(z.string()).default([]).volatile(),
})

export type PersonaConfig = ReturnType<typeof Config>

/** 人格数据根：`$DSH_HOME/persona`。没设 DSH_HOME 时退到 `~/.dsh`，优先级与 dsh-home-paths 一致。 */
export function personaRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.DSH_HOME?.trim()
  const home = configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
  return join(home, 'persona')
}

/** 一个人格自己的目录。会话的 cwd、人设、记忆、产物都在它下面。 */
export function personaDir(root: string, personaId: string): string {
  const segment = personaId.replace(/[^A-Za-z0-9._-]+/g, '-')
  return join(root, segment === '' ? 'default' : segment)
}

/** 读一个 volatile 字段的当前值；不是 ref（单元测试里直接传对象）时按普通值读。 */
export function readField<T>(field: unknown): T | undefined {
  if (field !== null && typeof field === 'object' && typeof (field as { get?: unknown }).get === 'function') {
    return (field as { get(): T | undefined }).get()
  }
  return field as T | undefined
}

/**
 * 一个场所现在是否在场。
 *
 * 缺省是在场：一个号被拉进哪个群是人的决定，人格在被拉进去的地方说话才自然。
 * 配置里列的是例外 —— 让它闭嘴的地方，而不是让它开口的地方。
 */
export function isVenueEnabled(config: PersonaConfig, venue: string): boolean {
  const muted = readField<string[]>(config.mutedVenues) ?? []
  return !muted.includes(venue)
}
