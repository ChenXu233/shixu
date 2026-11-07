import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { exposableActions, PRINCIPAL_PARAMETER, toolSpec } from './capabilities.js'
import { fetchImage } from './images.js'
import { visitBrief } from './brief.js'
import { Budget } from './budget.js'
import { decide, QUIET_GAP_MS } from './decision.js'
import { createJournal, type Journal } from './journal.js'
import { readCore } from './memory.js'
import { digestVenue, refreshProfiles, rollEpisode, type DigestHost } from './digest.js'
import { exportMemory, importMemory } from './mirror.js'
import { venueSection } from './brief.js'
import { askJev, type JudgeVerdict } from './judge.js'
import { parseVerdict, plannerPrompt } from './planner.js'
import { DIGEST_EVERY, Memory, memoryPath } from './store.js'
import { Perception } from './perception.js'
import { splitReply, typingDelay } from './timing.js'
import { venueTools } from './venue-tools.js'
import { judge, roleOf, seedMatrix, SELF, type Identity, type PermissionMatrix } from './permission.js'
import { venueKeyOf, type ChatSession, type KernelEvent, type MessageSegment, type UnifiedEvent } from './contracts.js'
import { Config, isVenueEnabled, personaDir, personaRoot, readField, type PersonaConfig } from './persona.js'

/** Cordis 插件名。 */
export const name = 'channel-binding'

/** 需要内核；`agents` 走嵌套 inject —— 它出现我才活，它消失我就停。 */
export const inject = ['channels']

/** 配置 schema 要给装载器与设置页看见。 */
export { Config }

/**
 * 我们只用得到 `ctx.agents` 的三件事：**第一次**为一个 sessionId 建 agent（带上 cwd），
 * **之后**按 id 取回同一个 agent，**已经落过盘**的会话恢复它。其余一概不碰。
 *
 * 形状是回读安装包核对过的（dsh-agent / dsh-session-persistence）：
 *   - `create` 收 `{ sessionId, meta: { cwd }, agentOptions }`，返回 **{ agent, dispose }**；
 *   - `resume` 只按 id 恢复，**没有 cwd 参数** —— 会话的 cwd 建好之后不再变；
 *   - `get(id)` 直接返回 agent；
 *   - 投递在 **agent.followup(message)** 上，参数是一条完整的 user 消息对象。
 * DSH 升级后必须重新核对这三点。
 */
interface AgentLike {
  followup(message: UserMessage): void
  /** 不唤醒、只把内容放进模型可见的上下文。DSH 的这个入口是 handle 上的，见 injectInto。 */
  inject?(payload: { content: unknown[]; source?: unknown }): unknown
  /** agent 作用域：工具与提示词段挂在这里，只对这一条会话生效。 */
  ctx?: AgentScopeLike
}

interface AgentScopeLike {
  tools?: {
    register(definition: unknown): unknown
    /** 同步闸门：返回字符串就是拒绝的理由。 */
    guard?(check: (exec: unknown) => string | undefined): unknown
  }
  systemPrompt?: { section(section: { name: string; order: number; text: string; interpolate?: boolean }): unknown }
}

/** 模型三件套；省略表示跟随部署默认。 */
export interface AgentModel {
  provider?: string
  model?: string
  reasoningEffort?: string
}

interface AgentHandleLike {
  agent: AgentLike
}

interface AgentsLike {
  get(id: string): AgentLike | undefined
  create(options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: AgentModel }): Promise<AgentHandleLike>
  resume(options: { resumeSessionId: string; agentOptions?: AgentModel }): Promise<AgentHandleLike>
}

/** 工作区登记只需要三件事：有没有、建没建、把会话挂进去。 */
interface WorkspaceRecordLike {
  path: string
  title: string
  setTitle(title: string): Promise<void>
  attachSession?(sessionId: string): Promise<void>
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceRecordLike[]
  create(path: string, title?: string): Promise<unknown>
}

/** `session/event` 的最小形状：我们只读类型，剩下交给会话自己。 */
interface SessionEventLike {
  type: string
  data?: unknown
}

interface SessionContextLike {
  on(name: 'session/event', listener: (session: { id: string }, event: SessionEventLike) => void): () => boolean
}

interface Logger {
  info(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/**
 * 一条 user 消息。dsh 的 `createUserMessage` 就是 `{ ...input, role: 'user', id }`
 * 再冻结一次（dsh-llm/lib/index.js），所以这里直接造出来，不去依赖 dsh-llm 的副本 ——
 * 插件里多装一份 dsh 内部包，比这个形状更危险。
 */
export interface UserMessage {
  id: string
  role: 'user'
  /** 文本块，加上已经落成附件的图片块。 */
  content: Array<{ type: 'text'; text: string } | { type: 'image'; attachment: unknown }>
  source: { kind: 'user' }
}

/** 附件服务里我们用得到的那一件：把编码图片换成持久引用。 */
interface AttachmentsLike {
  admitPromptContent(content: unknown[]): Promise<unknown[]>
}

/**
 * 把一条消息插进正在跑的那一轮。
 *
 * 用 inject（不唤醒、模型下一步可见），而不是 followup（那等于另起一轮）。
 * 拿不到这个入口就返回 false，调用方退回 followup —— 插不进去可以退化成排队，
 * 但绝不能把消息弄丢。
 */
function injectInto(agent: AgentLike, message: UserMessage): boolean {
  // 和 followup 收的是同一种东西：**完整的 user 消息**。只给 content 会被当成
  // 「没有身份的消息」写进会话日志，下一次 resume 会判定会话损坏 —— 线上那个群
  // 就是这么变成一条再也发不出去的会话的。
  const target = agent as unknown as { inject?: (input: UserMessage) => unknown }
  if (typeof target.inject !== 'function') return false
  try {
    target.inject(message)
    return true
  } catch {
    return false
  }
}

/** 会话日志坏了：这种情况只能弃用，重试没有意义。 */
function looksCorrupt(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name ?? ''
  if (name.includes('Corruption')) return true
  const text = String((error as { message?: string } | undefined)?.message ?? error)
  return text.includes('failed validation') || text.includes('corrupt session log')
}

/** 一条入站消息变成一个 user 消息，id 每条唯一（平台消息 id 可能重复，不能拿来当它）。 */
export function toUserMessage(text: string): UserMessage {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 一条入站消息变成模型真正收到的内容。
 *
 * 图片要**先落成附件**再进消息：模型看到的是图，不是一个 `[image]` 字样。
 * 取不到图就退回纯文本，不让一张坏图吞掉整条消息。
 */
export async function toInboundMessage(
  event: KernelEvent,
  attachments: AttachmentsLike | undefined,
  log?: Logger,
  journal?: Journal,
): Promise<UserMessage> {
  const text = renderInbound(event)
  const images = await inboundImages(event, log, journal)
  if (images.length === 0 || attachments === undefined) return toUserMessage(text)

  const content = await attachments.admitPromptContent([{ type: 'text', text }, ...images])
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: content as UserMessage['content'],
    source: { kind: 'user' },
  }
}

/** 把事件里的图片段取回来；取不到的跳过，顺序保持原样。 */
async function inboundImages(
  event: KernelEvent,
  log?: Logger,
  journal?: Journal,
): Promise<Array<{ type: 'image'; data: string; mediaType: string }>> {
  const urls = (event.message ?? [])
    .filter((segment) => segment.type === 'image')
    .map((segment) => String((segment.data as { url?: unknown }).url ?? ''))
    .filter((url) => url !== '')

  const images: Array<{ type: 'image'; data: string; mediaType: string }> = []
  for (const url of urls) {
    try {
      const image = await fetchImage(url)
      if (image === undefined) {
        log?.info('图片取不到或不是图片，跳过：%s', url)
        journal?.note('image', `取不到或不是图片，跳过：${url}`)
        continue
      }
      images.push({ type: 'image', ...image })
    } catch (error) {
      log?.error('图片下载失败：%s', String(error))
      journal?.note('image', `下载失败：${url} —— ${String(error)}`)
    }
  }
  return images
}

/** 一条入站消息渲染成模型看到的样子。来源事实走前缀，不走 source kind。 */
export function renderInbound(event: UnifiedEvent): string {
  const { venue } = event
  const where = [venue.platform, venue.accountId, venue.conversationId, venue.threadId]
    .filter((part) => part !== undefined && part !== '')
    .join('/')
  const source = [
    `platform="${venue.platform}"`,
    `account="${venue.accountId}"`,
    `venue="${where}"`,
    `sender="${event.actor?.id ?? 'unknown'}"`,
    ...(event.actor?.name === undefined ? [] : [`sender_name="${event.actor.name}"`]),
    `message="${event.messageId ?? ''}"`,
  ].join(' ')
  return `<dsh_source ${source}/>\n${event.text ?? ''}`
}

/**
 * 从一条 assistant 消息里取出**给人看的话**。思考块和工具调用不算。
 */
export function saidText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const item = block as { type?: string; text?: unknown } | undefined
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .join('')
    .trim()
}

/**
 * 把场所事件变成一轮对话，再把人格的回答送回那个场所。
 *
 * 铁律：**一个场所 = 一个 session + 一个 agent**，而**所有场所共用一个 cwd**——
 * 那是人格自己的工作区。按场所分 cwd 会让每个群在侧栏变成一个项目，
 * 很快就没有人能从侧栏里认出这是一个人格。
 */
export function apply(ctx: Context, config: PersonaConfig): void {
  const personaId = readField<string>(config.personaId) ?? 'default'
  const dir = personaDir(personaRoot(), personaId)
  const title = `时煦-${personaId}`
  const log = ctx.logger('channel-binding')
  const journal = createJournal(dir)
  /**
   * 出错时两处都写：容器日志（能看见最好）和人格目录下的日志文件（一定看得见）。
   *
   * DSH 的插件日志不进 `docker logs`，只写第一处等于没写。
   */
  const fail = (scope: string, message: string): void => {
    log.error(message)
    journal.note(scope, message)
  }
  journal.note('boot', `persona=${personaId} cwd=${dir}`)
  const attachments = resolveAttachments(ctx)
  let workspace: Promise<WorkspaceRecordLike | undefined> | undefined

  /** 会话 → 回到哪个场所。agent 的回答要靠它找回原群。 */
  const targets = new Map<string, ChatSession>()
  /** 会话 → 这一轮已经说出来的话。一次 turn 只发一条，否则一句话会被拆成好几条。 */
  const pending = new Map<string, string[]>()
  /** 会话 → 把它叫醒的那条消息（id + 时间），引用与否要看配置。 */
  const triggers = new Map<string, { id: string; at: number }>()
  /** 会话 → 模型让这一轮的正文挂到哪条消息下面（qq_reply_to 设的）。 */
  const outbound = new Map<string, string>()
  /** 已经挂进工作区的会话，一个进程只挂一次。 */
  const attached = new Set<string>()
  /** 已经配好工具与人格段的会话，一个进程只配一次。 */
  const equipped = new Set<string>()
  /** 这些贡献挂在别人的作用域上，插件卸载时要自己收回来。 */
  const disposers: Array<() => void> = []
  let persona: Promise<string> | undefined
  /**
   * 信任表：唯一能决定「谁能让它做什么」的东西。
   *
   * 闸门是同步的，所以读出来的值得提前放好 —— 启动时读一次，每条消息前再读一次，
   * 改了 identity.json 下一条消息就生效。
   */
  let trust: Identity = { owners: [], trusted: [] }
  /** 平台 → 出厂权限矩阵。动作目录变了才会重算。 */
  const matrices = new Map<string, PermissionMatrix>()
  /** 会话 → （消息 id → 谁说的）。会话事件只给消息 id，不给平台用户。 */
  const subjectsByMessage = new Map<string, Map<string, { subject: string; name?: string }>>()
  /** 会话 → 这一轮里真的开过口的人（id → 显示名）。动作执行时按它判权限。 */
  const speakers = new Map<string, Map<string, string | undefined>>()
  /** 每个场所听见了什么。没 @ 的消息也进这里，否则谈不上「在场」。 */
  const perception = new Perception()
  /** 场所键 → 会话信息。巡检醒来时要用它算出往哪发。 */
  const chats = new Map<string, ChatSession>()
  /** 全局记忆：一个库，所有场所共用。 */
  let memory: Memory | undefined
  /** 正在跑的那一轮（会话 id）。会话事件在 inject 外面，两边都得看得见。 */
  const running = new Set<string>()
  /** 判官上一次被叫的时刻与当时的未读数：冷却期内没新消息就不再花钱问一遍。 */
  const judgeAskedAt = new Map<string, number>()
  const lastPending = new Map<string, number>()
  /** 这一轮是被点名叫起来的：由人对着它说话，别的配额都得让路。 */
  const urgent = new Set<string>()
  /** 这一轮它自己调了 stay_quiet：正文不出站。 */
  const quietTurns = new Set<string>()
  /** 后台会话用完就释放：判官一次一问，不该在内存里留几百个 agent。 */
  const disposerOf = new Map<string, () => void>()
  /** 后台会话（摘要、判官）的状态：会话事件在 inject 外面，两边都得看得见。 */
  const DIGEST_SESSION = 'shixu-digest'
  const PLANNER_SESSION = 'shixu-planner'
  /** 后台会话 → 等它这一轮说完的回调。判官与摘要是两条独立的路。 */
  const backdropWaiters = new Map<string, (text: string) => void>()
  const backdropBuffers = new Map<string, string[]>()
  let maybeDigest: (venue: string) => void = () => {}
  /** 预算：同时看几个、一分钟说几句。 */
  const budget = new Budget(readField<number>(config.maxConcurrent) ?? 3, readField<number>(config.maxPerMinute) ?? 8)
  /** 会话 → 等这一轮结束的回调。同场所一次只服务一条消息，权限才不会张冠李戴。 */
  const turnDone = new Map<string, () => void>()

  ctx.effect(() => () => {
    // 库是独占的文件句柄：不关掉，重载之后旧库打不开新连接。
    try {
      memory?.close()
    } catch {
      /* 已经关了 */
    }
    memory = undefined
    for (const off of disposers.splice(0)) {
      try {
        off()
      } catch {
        /* 作用域可能先一步没了 */
      }
    }
  }, 'channel-binding.contributions')

  ctx.inject(['agents'], (scoped) => {
    const agents = (scoped as unknown as { agents: AgentsLike }).agents
    const live = new Map<string, AgentLike>()
    const queues = new Map<string, Promise<void>>()

    // 摘要会话：压段落、写画像都走它，不占场所的上下文。
    let digestRunning = false

    /**
     * 开张第一件事：库空了就从 markdown 恢复。
     *
     * 库是索引，markdown 才是正文 —— 换机器、回退版本，clone 下来这里自己会长回来。
     */
    const restoreMemory = async (): Promise<void> => {
      memory ??= new Memory(memoryPath(dir))
      if (memory.allFacts().length > 0) return
      try {
        const count = await importMemory(memory, dir)
        if (count.facts > 0 || count.paragraphs > 0) {
          journal.note('memory', `从文本恢复：${count.facts} 条事实、${count.people} 个人、${count.paragraphs} 段摘要`)
        }
      } catch (error) {
        journal.note('memory', `从文本恢复失败：${String(error)}`)
      }
    }
    void restoreMemory()

    let backdropSeq = 0
    /**
     * 问一个后台会话（摘要 / 判官），等它这一轮说完把话交回来。
     *
     * **一次一问，用完就扔**：每次都开新会话，答完立刻释放。复用一条会话的话，
     * 几百次判断会全堆在上下文里 —— 既越问越贵，上一批的结论也会干扰这一批。
     * 判官要的是「只看眼前这一批」，历史对它只有坏处。
     */
    const askBackdrop = async (kind: string, prompt: string, chosen?: string): Promise<string> => {
      workspace ??= prepareWorkspace(ctx, dir, title, log, journal)
      const record = await workspace
      const agentModel = chosen === undefined || chosen === '' ? (venueModel()) : { ...(venueModel()), ...{ model: chosen } }
      backdropSeq += 1
      const sessionId = `${kind}-${Date.now().toString(36)}-${backdropSeq.toString(36)}`
      const agent = await open(sessionId, agents, live, dir, agentModel, log, record, attached, disposerOf, false)
      const done = new Promise<string>((resolve) => {
        backdropWaiters.set(sessionId, resolve)
      })
      backdropBuffers.set(sessionId, [])
      agent.followup(toUserMessage(prompt))
      const answer = await done
      live.delete(sessionId)
      backdropBuffers.delete(sessionId)
      const dispose = disposerOf.get(sessionId)
      disposerOf.delete(sessionId)
      try {
        dispose?.()
      } catch {
        /* 释放失败不影响判定结果 */
      }
      return answer
    }

    const askDigest = (prompt: string): Promise<string> => askBackdrop(DIGEST_SESSION, prompt)

    const digestHost = (): DigestHost | undefined =>
      memory === undefined ? undefined : { memory, ask: askDigest, note: (text) => journal.note('memory', text) }

    /** 攒够了就压一段，压完顺手刷一下画像。失败只记日志，不影响回复。 */
    maybeDigest = (venue: string): void => {
      const host = digestHost()
      if (host === undefined || digestRunning) return
      const rows = memory!.unsummarized(venue)
      if (rows.length < DIGEST_EVERY) return

      digestRunning = true
      void (async () => {
        try {
          const summary = await digestVenue(host, venue, rows)
          if (summary !== '') await rollEpisode(host, venue, new Date().toISOString().slice(0, 10))
          await refreshProfiles(host)
          // 库变了就同步回 markdown：git 里看到的永远是最新的记忆。
          await exportMemory(host.memory, dir)
        } catch (error) {
          journal.note('memory', `压段落失败：${String(error)}`)
        } finally {
          digestRunning = false
        }
      })()
    }

    /**
     * 同一场所串行、不同场所并行。
     *
     * 这不是优化而是正确性：两条消息同时到达时，如果都先判断「还没有 agent」，
     * 就会重复创建、并且乱序投递。场所天然是串行的对话现场。
     */
    /**
   * 一个场所当前用哪条会话。
   *
   * 不是「一个群一条会话养到底」——那样每轮都要把前面几百条重发一遍，钱烧在历史上，
   * 一次口误也会跟着这条会话活很久。换成「一段对话一条会话」：最后一条消息在
   * `sessionIdleMs` 之内就接着用，超了就换一条新的，上下文从头开始。
   */
  const sessions = new Map<string, { id: string; lastAt: number }>()
  /** 每个场所各自编号：第一个场所的第一段会话不该叫 ...-2。 */
  const sessionSeq = new Map<string, number>()
  const sessionFor = (venue: string, at: number): string => {
    const current = sessions.get(venue)
    const idle = readField<number>(config.sessionIdleMs) ?? 600_000
    if (current !== undefined && at - current.lastAt < idle) {
      current.lastAt = at
      return current.id
    }

    // 换新会话：上一条的一切登记都撤掉，否则记忆里会堆一堆死键。
    if (current !== undefined) {
      live.delete(current.id)
      targets.delete(current.id)
      speakers.delete(current.id)
      subjectsByMessage.delete(current.id)
      triggers.delete(current.id)
      running.delete(current.id)
      urgent.delete(current.id)
      quietTurns.delete(current.id)
    }
    const seq = (sessionSeq.get(venue) ?? 0) + 1
    sessionSeq.set(venue, seq)
    // 第一段就叫 shixu-<场所>，和以前一样；之后按序号往后排，侧栏里也好认。
    const id = seq === 1 ? `shixu-${venue}` : `shixu-${venue}-${seq}`
    sessions.set(venue, { id, lastAt: at })
    return id
  }

  /**
   * 这条会话坏了，别再用了。
   *
   * 会话日志一旦判定损坏，每次 resume 都会失败 —— 一个群会永久哑掉。
   * 删掉登记，下一次就换一条新的；坏的留在磁盘上给人查。
   */
  const abandon = (venue: string): void => {
    const current = sessions.get(venue)
    if (current === undefined) return
    sessions.delete(venue)
    live.delete(current.id)
    targets.delete(current.id)
    speakers.delete(current.id)
    subjectsByMessage.delete(current.id)
    triggers.delete(current.id)
    running.delete(current.id)
    urgent.delete(current.id)
    quietTurns.delete(current.id)
    journal.note('deliver', `${venue} 弃用坏会话 ${current.id}`)
  }

  const serialize = (venue: string, task: () => Promise<void>): void => {
      const previous = queues.get(venue) ?? Promise.resolve()
      const next = previous.then(task, task).catch((error: unknown) => {
        // 事件不能因为一轮投递失败而静默消失。
        fail('deliver', `venue ${venue} 投递失败：${String(error)}`)
      })
      queues.set(venue, next)
      void next.then(() => {
        if (queues.get(venue) === next) queues.delete(venue)
      })
    }

    /**
     * 给一条会话装上它该有的东西：人格文本，和这个场所能自主执行的动作。
     *
     * 都挂在 `agent.ctx` 上 —— 作用域注册只对这一个 agent 可见，
     * 不会串到别的群，也不会污染全局工具表。
     */
  /**
   * 判定这次调用能不能做。
   *
   * 三步：先看它声明替谁做（不声明就按这一轮唯一的发言人算），再查这个人的角色，
   * 最后按矩阵判工具名。返回字符串就是拒绝的理由 —— 空字符串表示放行。
   */
  const denialFor = (sessionId: string, platform: string, exec: { name?: string; arguments?: unknown }): string => {
    const name = exec.name ?? ''
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    const declared = typeof args.principal === 'string' ? args.principal.trim() : ''

    const speaking = speakers.get(sessionId) ?? new Map<string, string | undefined>()
    /** 昵称跟着账号一起给：模型不该自己去对「1964324406 是谁」。 */
    const named = (id: string): string => {
      const display = speaking.get(id)
      return display === undefined || display === '' ? '' : ` name=${display}`
    }

    let subject = ''
    if (declared === SELF) {
      subject = SELF
    } else if (declared !== '') {
      if (!speaking.has(declared)) {
        fail('permission', `拒绝 ${name}：${declared} 不是这一轮的发起人`)
        return `拒绝：tool=${name} principal=${declared} 原因=不是本轮的发起人`
      }
      subject = declared
    } else if (speaking.size === 1) {
      subject = [...speaking.keys()][0] ?? ''
    } else if (speaking.size === 0) {
      // 这一轮没有可识别的发言人：可能它自己在自言自语。按「它自己」算。
      subject = SELF
    } else {
      // 一轮里有好几个人说话（中途插进来的消息就会造成这种情况）。
      // 这时候「替谁做」不能靠猜，必须由模型声明 —— 声明是它唯一的义务。
      const who = [...speaking.entries()]
        .map(([id, display]) => (display === undefined || display === '' ? id : `${id}(${display})`))
        .join('、')
      fail('permission', `拒绝 ${name}：本轮有多个说话人（${who}），没有声明 principal`)
      return `拒绝：tool=${name} 原因=这一轮有多个说话人（${who}），请用 principal 声明这条是为谁做的`
    }

    const role = roleOf(subject, trust)
    const matrix = matrices.get(platform)
    if (matrix === undefined) return `拒绝：tool=${name} 原因=这个场所没有可用的动作目录`

    const decision = judge(matrix, role, name)
    if (decision === 'allow') return ''
    fail('permission', `拒绝 ${name}：${subject} 是 ${role}（${decision}）`)
    return `拒绝：tool=${name} principal=${subject}${named(subject)} role=${role} 原因=角色不允许`
  }

  /**
   * 这一轮用哪个模型。
   *
   * 人格配置里写了就照写；没写就跟随部署默认，但**去掉 reasoningEffort**。
   * 部署默认是给编码任务配的 max 档，一次群聊回复要推理一分钟 —— 群里没人等得起。
   * 所以跟随默认模型时，推理档固定降到 `low`：群聊要的是快，不是想得深。
   */
  const venueModel = (): AgentModel | undefined => {
    const explicit = model(config)
    if (explicit !== undefined) return explicit
    const base = defaultModel(ctx) as AgentModel | undefined
    if (base === undefined) return undefined
    const { provider, model: id } = base
    if (provider === undefined || id === undefined) return base
    return { provider, model: id, reasoningEffort: 'low' }
  }

  const equip = async (sessionId: string, agent: AgentLike, chat: ChatSession): Promise<void> => {
      if (equipped.has(sessionId)) return
      equipped.add(sessionId)

      const scope = agent.ctx
      if (scope === undefined) return

      // 每次装备都现读：文件是人改的，改完下一条就该生效，不能吃一次缓存吃到进程死。
      const text = await readPersonaText(dir).catch(() => '')
      journal.note('equip', `人格文本 ${text.length} 字，提示段=${scope.systemPrompt === undefined ? '没有' : '有'}（${sessionId}）`)
      if (text !== '' && scope.systemPrompt !== undefined) {
        try {
          // 用**部署人设那一段的名字**注册，才会遮蔽它，而不是排在它后面。
          // 排在后面时，模型先看到的是「You are a coding agent…」，问到身份它就照那句答，
          // 人格只是背景音。这正是线上「压根没有人格」的来源。
          const shadow = scope.systemPrompt as unknown as {
            getSectionOrder?(name: string): number
            section(options: { name: string; order: number; text: string; interpolate?: boolean }): unknown
          }
          const order = typeof shadow.getSectionOrder === 'function' ? shadow.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') : 0
          const off = shadow.section({ name: 'deployment:persona-prefix', order, text, interpolate: false })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `人格提示段注册失败：${String(error)}`)
        }
      }

      // 它现在站在哪儿、说话怎么算发出去了。这一段以前没有，模型只能从工具描述里
      // 反推「我直接说话就是回复」，常常推错：要么不动，要么用括号写旁白。
      if (scope.systemPrompt !== undefined) {
        try {
          const off = scope.systemPrompt.section({
            name: 'shixu:venue',
            order: 15,
            text: venueSection(chat),
            interpolate: false,
          })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `在场提示段注册失败：${String(error)}`)
        }
      }

      // 它自己的记忆：写进 core.md，读进提示。有记忆它才知道该学什么。
      const coreSection = (memory: string): string =>
        memory === ''
          ? '（你还没有存下任何记忆。遇到以后还想得起来的事，就用 remember 记一笔。）'
          : '（下面是你自己记下的事。要用 remember 添加，或者用 remember 的 replaced 参数改掉记错的那条。）\n' + memory

      let coreOff: (() => void) | undefined
      const registerCore = async (): Promise<void> => {
        if (scope.systemPrompt === undefined) return
        const memory = await readCore(dir)
        if (coreOff !== undefined) {
          coreOff()
          coreOff = undefined
        }
        try {
          const off = scope.systemPrompt.section({
            name: 'shixu:core',
            order: 20,
            text: coreSection(memory),
            interpolate: false,
          })
          if (typeof off === 'function') {
            coreOff = off as () => void
            disposers.push(coreOff)
          }
        } catch (error) {
          fail('equip', `记忆提示段注册失败：${String(error)}`)
        }
      }
      await registerCore()

      const driver = ctx.channels.getDriver(chat.protocol)
      if (driver === undefined || scope.tools === undefined) return

      const actions = exposableActions(driver.actions ?? [])
      // history / search 由驱动提供（平台有历史接口）；内核补「怎么说」的两件。
      // remember 不给 guest：记忆会传染，陌生人不能往它脑子里写东西。
      const kernelNames = [`${chat.venue.platform}_reply_to`, `${chat.venue.platform}_send`]
      const ownerOnly = ['remember', 'link_account']
      let matrix = matrices.get(chat.venue.platform)
      if (matrix === undefined) {
        matrix = seedMatrix(chat.venue.platform, actions, kernelNames, ownerOnly)
        matrices.set(chat.venue.platform, matrix)
      }

      for (const action of actions) {
        try {
          const off = scope.tools.register({
            ...toolSpec(chat.venue.platform, action),
            output: {
              schema: { type: 'string' },
              render: (_args: unknown, value: unknown) => [
                { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
              ],
            },
            async execute(args: Record<string, unknown>) {
              // principal 只是给判定看的，不往平台上传；场所身份随调用带上，
              // 模型不该自己背「这个群是哪个 group_id」。
              const { principal: _principal, ...params } = args ?? {}
              return JSON.stringify(await driver.call(action.name, { ...params, session: chat }))
            },
          })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `工具注册失败（${action.name}）：${String(error)}`)
        }
      }

      for (const tool of venueTools({
        platform: chat.venue.platform,
        venueKey: chat.key,
        sessionId,
        chat,
        perception,
        send: (target, segments) => ctx.channels.send(target, segments),
        setOutbound: (id, messageId) => outbound.set(id, messageId),
        stayQuiet: (id) => quietTurns.add(id),
      })) {
        try {
          const off = scope.tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: {
              schema: { type: 'string' },
              render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
            },
            async execute(args: Record<string, unknown>) {
              const { principal: _principal, ...rest } = args ?? {}
              return await tool.run(rest)
            },
          })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `内核工具注册失败（${tool.name}）：${String(error)}`)
        }
      }

      // 记忆工具：写事实、查记忆。数据全在库里，不分散在文件。
      const memoryToolDefs = [
        {
          name: 'remember',
          description: '把关于你自己或主人的事记进长期记忆（一句话一条）。以后任何时候都能用 memory_search 查回来。',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '一句话' },
              about: { type: 'string', description: '可选：关于谁；不填就是关于你自己' },
              principal: PRINCIPAL_PARAMETER,
            },
            required: ['text', 'principal'],
          },
          async run(args: Record<string, unknown>) {
            const line = String(args.text ?? '').trim()
            if (line === '') throw new Error('text 不能为空')
            const about = String(args.about ?? '').trim()
            memory ??= new Memory(memoryPath(dir))
            memory.addFact({ about, text: line, at: Date.now() })
            journal.note('memory', `事实：${about === '' ? '自己' : about} — ${line}`)
            return '记下了'
          },
        },
        {
          name: 'remember_person',
          description: '记一条关于某个人的事（他是谁、喜欢什么、最近在忙什么）。同一个人换个账号来说话，也记在同一个名字下。',
          parameters: {
            type: 'object',
            properties: {
              person: { type: 'string', description: '这个人的名字' },
              text: { type: 'string', description: '一句话' },
              principal: PRINCIPAL_PARAMETER,
            },
            required: ['person', 'text', 'principal'],
          },
          async run(args: Record<string, unknown>) {
            const name = String(args.person ?? '').trim()
            const line = String(args.text ?? '').trim()
            if (name === '' || line === '') throw new Error('person 与 text 都不能为空')
            memory ??= new Memory(memoryPath(dir))
            memory.upsertEntity('person', name)
            memory.addFact({ about: name, text: line, at: Date.now() })
            journal.note('memory', `${name}：${line}`)
            return '记到 ' + name + ' 名下了'
          },
        },
        {
          name: 'memory_search',
          description: '在你的长期记忆里搜。想知道谁以前说过什么、某件事是什么时候聊的，就来这里找 —— 记忆不在上下文里，要查才有。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '要找的词或句子' },
              limit: { type: 'number', description: '最多几条，默认 10' },
              principal: PRINCIPAL_PARAMETER,
            },
            required: ['query', 'principal'],
          },
          async run(args: Record<string, unknown>) {
            const query = String(args.query ?? '').trim()
            if (query === '') throw new Error('query 不能为空')
            const limit = Math.max(1, Math.min(Number(args.limit ?? 10) || 10, 30))
            memory ??= new Memory(memoryPath(dir))
            const hits = memory.search(query, limit)
            journal.note('memory', `查：${query} → ${hits.length} 条`)
            if (hits.length === 0) return '记忆里没有和「' + query + '」相关的事。'
            return hits
              .map((hit) => {
                const when = new Date(hit.at).toISOString().slice(0, 16).replace('T', ' ')
                return `[${hit.kind === 'fact' ? '事' : '话'}] ${when} ${hit.body}`
              })
              .join('\n')
          },
        },
      ]

      for (const tool of memoryToolDefs) {
        try {
          const off = scope.tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: {
              schema: { type: 'string' },
              render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
            },
            async execute(args: Record<string, unknown>) {
              const { principal: _principal, ...rest } = args ?? {}
              return await tool.run(rest)
            },
          })
          if (typeof off === 'function') disposers.push(off as () => void)
        } catch (error) {
          fail('equip', `记忆工具注册失败（${tool.name}）：${String(error)}`)
        }
      }
      // 拦在闸门上而不是拦在注册时：一个场所只有一个 agent，工具列表是共用的，
      // 但每一轮是谁在说话都不一样。闸门也顺手管住了主机上的内置工具。
      if (typeof scope.tools.guard === 'function') {
        const off = scope.tools.guard((exec: unknown) => {
          const reason = denialFor(sessionId, chat.venue.platform, exec as { name?: string; arguments?: unknown })
          return reason === '' ? undefined : reason
        })
        if (typeof off === 'function') disposers.push(off as () => void)
      }
    }

  /**
   * 判一次「要不要去看一眼」。影子模式下只记日志，不叫醒。
   *
   * 延时是给一串短消息留的合并窗口：真人看群也是等一句话说完，不是逐字反应。
   */
  const judgeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // 安静巡检：没人说话的时候也要回去看看 —— 人会在群里冒一句「怎么不聊了」。
  // 只查已经安静够久的场所，否则每五分钟刷一遍日志。
  const quietTimer = setInterval(() => {
    const now = Date.now()
    for (const venue of perception.keys()) {
      const state = perception.state(venue)
      if (state === undefined) continue
      const last = state.recent.at(-1)?.at ?? state.firstSeenAt
      if (now - last < QUIET_GAP_MS) continue
      judgeVisit(venue, false)
    }
  }, 5 * 60_000)
  const scheduleJudge = (venue: string, isPrivate: boolean): void => {
    const running = judgeTimers.get(venue)
    if (running !== undefined) clearTimeout(running)
    const timer = setTimeout(() => {
      judgeTimers.delete(venue)
      judgeVisit(venue, isPrivate)
    }, readField<number>(config.judgeWindowMs) ?? 3_000)
    judgeTimers.set(venue, timer)
  }

  /** 同一个判定的收口：事件触发与安静巡检都走这里，日志格式只有一份。 */
  const judgeVisit = (venue: string, isPrivate: boolean): void => {
    const state = perception.state(venue)
    if (state === undefined) return
    const now = Date.now()
    const pending = state.pending.length
    const lastMessageAt = state.recent.at(-1)?.at ?? now
    const decision = decide({
      pending,
      mentioned: false,
      named: false,
      isPrivate,
      sinceLastVisitMs: state.lastVisitAt === 0 ? Number.MAX_SAFE_INTEGER : now - state.lastVisitAt,
      sinceLastMessageMs: now - lastMessageAt,
      sinceQuietVisitMs: state.lastQuietVisitAt === 0 ? Number.MAX_SAFE_INTEGER : now - state.lastQuietVisitAt,
      talkValue: readField<number>(config.talkValue) ?? 1,
      silenceStreak: state.silenceStreak,
    })
    const liveMode = (readField<string>(config.attention) ?? 'shadow') === 'live'
    // 安静去看过就记一笔，下次要等三个小时。
    if (decision.act === 'visit' && decision.reasons[0]?.includes('安静')) state.lastQuietVisitAt = now

    // 「有人在聊」这一种交给判官：规则只会数条数，看不懂「这句话值不值得接」。
    const byCount = decision.act === 'visit' && decision.reasons[0]?.startsWith('积压')
    if (!byCount) {
      journal.note(
        'attention',
        `${venue} ${decision.act}${liveMode ? '' : '(影子)'} 积压=${pending} 静了=${Math.round((now - lastMessageAt) / 1000)}s｜${decision.reasons.join('，')}`,
      )
      if (decision.act === 'visit' && liveMode) wake(venue, state)
      else perception.markJudged(venue, decision.act === 'visit')
      return
    }

    // 判官一次是一条真实的消息，不能每条都问：冷却期内只记账，不再花一次调用。
    const cooldown = readField<number>(config.judgeCooldownMs) ?? 120_000
    const lastAsked = judgeAskedAt.get(venue) ?? 0
    if (now - lastAsked < cooldown && state.pending.length <= lastPending.get(venue)!) return
    judgeAskedAt.set(venue, now)
    lastPending.set(venue, state.pending.length)

    // 一次给判官 20 条：太少它只看得到半句话，太多它读不完。
    void askJudge(venue, state, state.pending.slice(-20), liveMode)
  }

  /** 问判官值不值得看。判官说不看，就记一笔继续沉默——它连叫醒的成本都省了。 */
  const askJudge = async (
    venue: string,
    state: {
      recent: Array<{ id: string; name?: string; subject: string; text: string; images: number; at: number }>
      lastSpokeAt: number
      pending: Array<{ id: string; name?: string; subject: string; text: string; images: number }>
    },
    batch: Array<{ id: string; name?: string; subject: string; text: string; images: number }>,
    liveMode: boolean,
  ): Promise<void> => {
    const brief = (await readPersonaText(dir).catch(() => '')).split('\n').filter((one) => one.trim() !== '').slice(0, 2).join('，').slice(0, 120)
    const prompt = plannerPrompt({
      persona: brief === '' ? '一个在群里待着的人' : brief,
      messages: batch.map((one) => ({ id: one.id, speaker: one.name ?? one.subject, text: one.text })),
      minutesSinceSpoke: state.lastSpokeAt === 0 ? undefined : Math.round((Date.now() - state.lastSpokeAt) / 60_000),
    })

    let verdict: JudgeVerdict = { look: true, reason: '', confidence: 1 }
    const backend = readField<string>(config.judge) ?? 'model'
    try {
      if (backend === 'jev') {
        // 一次 HTTP POST，没有会话、没有工具循环：JEV 不是聊天模型。
        const apiKey = process.env[readField<string>(config.jevApiKeyEnv) ?? 'TYPESAFE_API_KEY'] ?? ''
        if (apiKey === '') throw new Error('没有 API key')
        verdict = await askJev({
          state: prompt,
          baseUrl: readField<string>(config.jevBaseUrl) ?? 'https://api.typesafe.ai',
          apiKey,
          model: readField<string>(config.jevModel) ?? 'jev-latest',
        })
      } else {
        const answer = await askBackdrop(PLANNER_SESSION, prompt, readField<string>(config.plannerModel) ?? '')
        const parsed = parseVerdict(answer)
        verdict = { ...parsed, confidence: 1 }
      }
    } catch (error) {
      journal.note('attention', `判官失败（${backend}），按值得处理：${String(error)}`)
    }

    journal.note(
      'attention',
      `${venue} 判官=${verdict.look ? '值得' : '不值得'}(${verdict.confidence.toFixed(2)})${liveMode ? '' : '(影子)'} 未读=${state.pending.length} 问的=${batch.length}｜${verdict.reason}`,
    )
    if (verdict.look && liveMode) wake(venue, state)
    else {
      // 判官说过「不值得」的那批划掉：不划掉的话，同一个话题每次新消息都会再花一次钱。
      perception.markSeen(venue, batch.length)
    }
  }

  /** 醒过来：把它看到的最近几条交过去，说不说由它决定。 */
  const wake = (venue: string, state: { recent: Array<{ id: string; name?: string; subject: string; text: string; images: number; at: number }> }): void => {
    const chat = chats.get(venue)
    if (chat === undefined) return
    if (!budget.tryEnter(venue)) {
      journal.note('attention', `${venue} 跳过：并发已满（${budget.size()}）`)
      perception.markJudged(venue, false)
      return
    }

    const last = state.recent.at(-1)?.at ?? Date.now()
    const text = visitBrief({
      venueLabel: `${chat.venue.platform} ${chat.venue.conversationId}`,
      quietForMs: Date.now() - last,
      messages: state.recent.slice(-8),
    })
    // 冷场探访：也是一段新对话，接上一段只会把旧账拖进来。
    const sessionId = sessionFor(venue, Date.now())
    targets.set(sessionId, chat)

    serialize(venue, async () => {
      try {
        workspace ??= prepareWorkspace(ctx, dir, title, log, journal)
        const record = await workspace
        const agent = await open(sessionId, agents, live, dir, venueModel(), log, record, attached, disposerOf, true)
        await equip(sessionId, agent, chat)
        trust = await readIdentity(dir)
        agent.followup(toUserMessage(text))
        perception.markJudged(venue, true)
      } finally {
        budget.leave(venue)
      }
    })
  }
    scoped.on('channels/event', (event: KernelEvent) => {
      // 只有「有人说话」才唤醒人格。成员变化是别的消费者的事（在场感、记忆）。
      if (event.type !== 'message') return
      // 自己说的话不叫醒自己：否则它一发出去就收到自己那条，接着回自己。
      if (event.self) return

      const venue = venueKeyOf(event)
      const aliases = readField<string[]>(config.aliasNames) ?? []
      const mentioned = isMentioned(event)
      const addressed = isAddressed(event, aliases)
      const text = event.text ?? ''
      const images = (event.message ?? []).filter((segment) => segment.type === 'image').length

      // 先记下来，再决定理不理。没 @ 的也要「听见」，否则它对群一无所知。
      if (text !== '' || images > 0) {
        // 不落库的东西以后都查不到：每条消息都进库，全局一份。
        memory ??= new Memory(memoryPath(dir))
        memory.addMessage({
          id: event.id,
          venue,
          platform: event.venue.platform,
          speakerId: event.actor?.id ?? '',
          speakerName: event.actor?.name,
          text,
          at: event.timestamp,
          platformMessageId: event.messageId,
        })

        chats.set(venue, {
          key: venue,
          venue: event.venue,
          protocol: event.protocol,
          conversationType: event.conversationType,
        })
        perception.observe(venue, {
          id: event.id,
          subject: event.actor?.id ?? '',
          name: event.actor?.name,
          text,
          images,
          at: event.timestamp,
        })
      }

      if (text === '') return
      if (!isVenueEnabled(config, venue)) return

      // 判定先跑影子模式：只记它「会不会接」，不改行为。等日志里能看出分寸了再放开。
      if (!addressed) {
        // 合成一批再判：一条一判等于永远「积压 1 条」，热度永远攒不起来。
        scheduleJudge(venue, event.conversationType === 'private')
        return
      }

      const sessionId = sessionFor(venue, event.timestamp)
      const chat: ChatSession = {
        key: venue,
        venue: event.venue,
        protocol: event.protocol,
        conversationType: event.conversationType,
      }
      targets.set(sessionId, chat)
      // 这一轮是点名来的：出站时不受「一分钟几句」限制。
      if (mentioned || event.conversationType === 'private') urgent.add(sessionId)

      serialize(venue, async () => {
        const beganAt = Date.now()
        workspace ??= prepareWorkspace(ctx, dir, title, log, journal)
        const record = await workspace
        // 会话坏了就换一条：坏的留在磁盘上给人查，这个群不能跟着哑掉。
        let active = sessionId
        let agent = await open(active, agents, live, dir, venueModel(), log, record, attached, disposerOf, true).catch(async (error: unknown) => {
          if (!looksCorrupt(error)) throw error
          abandon(venue)
          active = sessionFor(venue, Date.now())
          targets.set(active, chat)
          return await open(active, agents, live, dir, venueModel(), log, record, attached, disposerOf, true)
        })
        const openedAt = Date.now()
        await equip(active, agent, chat)
        const equippedAt = Date.now()

        trust = await readIdentity(dir)

        if (event.messageId !== undefined && event.messageId !== '') {
          triggers.set(active, { id: event.messageId, at: event.timestamp })
        }

        const message = await toInboundMessage(event, attachments, log, journal)

        // 说话的人是谁：库里关于他的最近几条事实。全局一份，换个群也认得。
        memory ??= new Memory(memoryPath(dir))
        const speaker = event.actor?.name ?? event.actor?.id ?? ''
        const notes = speaker === '' ? [] : memory.recentFacts(speaker, 5)
        const profile = speaker === '' ? undefined : memory.profileOf(speaker)
        if (notes.length > 0 || profile !== undefined) {
          const digest = notes.map((one) => one.text).join('；').slice(0, 200)
          const who = profile === undefined ? `（说话的是 ${speaker}。你记下的：${digest}）` : `（说话的是 ${speaker}。你记得他：${profile}）`
          message.content.unshift({ type: 'text', text: who })
        }

        // 这个场所最近的摘要：不用把几百条消息塞进来，几句概括就够。
        const paragraphs = memory.recentParagraphs(venue, 2)
        if (paragraphs.length > 0) {
          const gist = paragraphs.map((one) => one.summary).join(' \n').slice(0, 400)
          message.content.unshift({ type: 'text', text: `（这个群最近聊过：${gist}）` })
        }
        // 会话事件只告诉我们「哪条消息进来了」，不告诉我们平台的用户 id。
        // 所以投递前先把消息 id 记下来，等 user/message 事件到了一查就知道是谁。
        const byMessage = subjectsByMessage.get(sessionId) ?? new Map<string, { subject: string; name?: string }>()
        byMessage.set(message.id, { subject: event.actor?.id ?? '', name: event.actor?.name })
        subjectsByMessage.set(sessionId, byMessage)

        // 这一轮还在跑：把消息插进它的下一步，不另起一轮。
        // 模型在同一个 turn 里会看到两个说话人，工具调用必须自己声明替谁做。
        // 从收到到真正投给模型隔了多久：卡住的时候必须能从日志里一眼看出来。
        const spent = Date.now() - event.timestamp
        if (spent > 5000) journal.note('deliver', `${venue} 排队 ${Math.round(spent / 1000)}s 才轮到它说话`)
        if (spent > 1_000) {
          journal.note(
            'timing',
            `${venue} 收到→投递 ${spent}ms（建会话 ${openedAt - beganAt}ms 装工具 ${equippedAt - openedAt}ms 备内容 ${Date.now() - equippedAt}ms）`,
          )
        }

        // 等太久了就别回了：一句迟到的回答，内容一定是错的 —— 群里早聊到别处去了。
        const staleAfter = readField<number>(config.staleAfterMs) ?? 120_000
        if (spent > staleAfter) {
          journal.note('deliver', `${venue} 丢弃过期消息：等了 ${Math.round(spent / 1000)}s（上限 ${Math.round(staleAfter / 1000)}s）`)
          perception.markJudged(venue, true)
          return
        }

        if (running.has(sessionId) && injectInto(agent, message)) {
          // 注入不会触发 user/message，说话人得我们自己记：不然这一轮的第二个发言人
          // 在闸门那里是隐形的，工具调用会被算到第一个人头上。
          const said = speakers.get(sessionId) ?? new Map<string, string | undefined>()
          said.set(event.actor?.id ?? '', event.actor?.name)
          speakers.set(sessionId, said)
          journal.note('deliver', `${venue} 插入进行中的一轮：${event.actor?.name ?? event.actor?.id ?? ''}`)
        } else {
          agent.followup(message)
        }
        perception.markJudged(venue, true)
      })
    })
  })

  /**
   * 一句话要带引用吗 —— 这是主人定的口味，不是引擎定的。
   *
   * `never`（默认）：真人不每句都引用，引用多了像客服系统。
   * `when-older`：答的不是最新那条时才引用 —— 那种时候不引用，群里真不知道在答哪句。
   * `always`：只在明确想要「每条都挂回原消息」的场合用。
   */
  const replySegments = (sessionId: string, chat: ChatSession, text: string): MessageSegment[] => {
    const plain: MessageSegment[] = [{ type: 'text', data: { text } }]
    const canQuote = ctx.channels.getDriver(chat.protocol)?.capabilities.sendQuote === true

    // 模型自己指定的优先：它调过 reply_to，就照它说的挂。
    const chosen = outbound.get(sessionId)
    if (chosen !== undefined) {
      outbound.delete(sessionId)
      if (canQuote && chat.conversationType !== 'private') {
        return [{ type: 'quote', data: { messageId: chosen } }, ...plain]
      }
      return plain
    }

    const mode = readField<string>(config.quote) ?? 'never'
    if (mode === 'never') return plain

    const trigger = triggers.get(sessionId)
    if (trigger === undefined || !canQuote || chat.conversationType === 'private') return plain

    if (mode === 'when-older') {
      // chat.key 与感知缓冲用的是同一个场所键（都来自 venueKeyOf）。
      const newer = (perception.state(chat.key)?.recent ?? []).some((message) => message.at > trigger.at)
      if (!newer) return plain
    }

    return [{ type: 'quote', data: { messageId: trigger.id } }, ...plain]
  }

  /**
   * 出站：人格说出来的话，回到它说话的那个场所。
   *
   * 挂在根上下文上 —— 会话事件是从会话服务那里发出来的，我们的插件上下文是它的兄弟，
   * 不是它的祖先。
   */
  ctx.effect(() => {
    const root = ctx.root as unknown as SessionContextLike
    const off = root.on('session/event', (session, event) => {
      // 摘要 / 判官会话不打回任何场所：它们说的话只在这里被收走。
      // 每次都是新会话（用完即弃），所以按前缀认，不能按固定 id 认。
      if (session.id.startsWith(DIGEST_SESSION) || session.id.startsWith(PLANNER_SESSION)) {
        const buffer = backdropBuffers.get(session.id) ?? []
        backdropBuffers.set(session.id, buffer)
        if (event.type === 'assistant/message') {
          const said = saidText((event.data as { message?: unknown } | undefined)?.message)
          if (said !== '') buffer.push(said)
          return
        }
        if (event.type !== 'turn/end') return
        const waiter = backdropWaiters.get(session.id)
        backdropWaiters.delete(session.id)
        waiter?.(buffer.join('\n\n').trim())
        backdropBuffers.set(session.id, [])
        return
      }

      const chat = targets.get(session.id)
      if (chat === undefined) return

      // 记下「这一轮在跑」，中途来的消息才知道该插进去还是另起一轮。
      if (event.type === 'turn/start') {
        running.add(session.id)
        return
      }

      // 这一轮里谁真的开了口。权限判定只认这个集合 —— 不是「最近谁说过话」，
      // 更不是「平台上谁是管理员」。
      if (event.type === 'user/message') {
        const id = (event.data as { message?: { id?: unknown } } | undefined)?.message?.id
        const said = typeof id === 'string' ? subjectsByMessage.get(session.id)?.get(id) : undefined
        if (said !== undefined) {
          const set = speakers.get(session.id) ?? new Map<string, string | undefined>()
          set.set(said.subject, said.name)
          speakers.set(session.id, set)
        }
        return
      }

      if (event.type === 'assistant/message') {
        const text = saidText((event.data as { message?: unknown } | undefined)?.message)
        if (text === '') return
        const said = pending.get(session.id) ?? []
        said.push(text)
        pending.set(session.id, said)
        return
      }

      if (event.type !== 'turn/end') return

      const said = pending.get(session.id) ?? []
      pending.delete(session.id)
      const text = said.join('\n\n').trim()

      // 它自己说了「这一轮不说话」：结构化的一条指令，不是靠正文里写暗号。
      if (quietTurns.has(session.id)) {
        quietTurns.delete(session.id)
        journal.note('attention', `${chat.key} 这轮不说话（stay_quiet）`)
        return
      }

      if (text !== '') {
        // 被点名的那一轮不受「一分钟最多几句」限制：人对着它说话，不能因为配额把它噎回去。
        if (!budget.allowSpeak() && !urgent.has(session.id)) {
          journal.note('attention', `${chat.key} 跳过发送：这一分钟说得够多了`)
          return
        }
        budget.noteSpoke()

        // 像人那样发：先停一下，说一句，再看要不要补一句。
        const chunks = splitReply(text, readField<number>(config.replyMaxChunks) ?? 3)
        const base = readField<number>(config.typingDelayMs) ?? 600
        void (async () => {
          for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index] ?? ''
            const wait = typingDelay(chunk, base)
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
            // 只有第一条挂引用：后面几条是接着说，不需要每条都指回原消息。
            const segments: MessageSegment[] =
              index === 0 ? replySegments(session.id, chat, chunk) : [{ type: 'text', data: { text: chunk } }]
            await ctx.channels.send(chat, segments)
          }
        })().catch((error: unknown) => {
          fail('reply', `venue ${chat.key} 回复发送失败：${String(error)}`)
        })
      }

      // 攒够了就压一段：这件事和回不回话无关，所以放在出站之后。
      maybeDigest(session.id.replace(/^shixu-/, ''))

      running.delete(session.id)
      urgent.delete(session.id)
      quietTurns.delete(session.id)

      // 一轮结束，说话人清空：下一条消息重新算，不继承上一轮的身份。
      speakers.delete(session.id)
      subjectsByMessage.delete(session.id)
      outbound.delete(session.id)
    })
    return () => void off?.()
  }, 'channel-binding.replies')
}

/**
 * 跟随部署默认：读 `agentDefaultModel` 现在选的是哪个。
 *
 * 不读这一个，会话就没有模型 —— prompt 里的 `{{model}}` 变量没人填，
 * 每一轮都在装配阶段直接失败，群里一句话都不会有。
 */
type DefaultModelLike = { currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } }

function defaultModel(ctx: Context): AgentModel | undefined {
  try {
    // 从根上下文找：这个服务是可选依赖，进不了 inject 名单，插件自己的作用域里看不见它。
    // 服务没装时读属性或 get() 都可能抛 —— 缺了就当没配。
    const probe = ctx.root as unknown as { get?(name: string): unknown; agentDefaultModel?: DefaultModelLike }
    const owner = probe.agentDefaultModel ?? (typeof probe.get === 'function' ? (probe.get('agentDefaultModel') as DefaultModelLike | undefined) : undefined)
    if (owner === undefined) return undefined
    const selection = owner.currentSelection()
    if (selection.provider === undefined || selection.model === undefined) return undefined
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  } catch {
    return undefined
  }
}

/**
 * 现在该不该开口。
 *
 * 私聊必回；群与频道里只在被 @ 到时开口。一个群里有人聊天不代表在叫它 ——
 * 逐条接话会把它变成噪音源，而噪音源会被踢出去。
 */
export function isAddressed(event: KernelEvent, aliases: readonly string[] = []): boolean {
  if (event.conversationType === 'private') return true
  if (isMentioned(event)) return true
  // 没 @ 但打了名字也算在叫它。群里有人聊到同名的人时会被误叫醒，
  // 所以只在名字是「不怎么出现在日常对话里的词」时才配。
  const text = event.text ?? ''
  return aliases.some((alias) => alias !== '' && text.includes(alias))
}

/** 结构化的 @：段里有 mention，且点的是它自己。 */
export function isMentioned(event: KernelEvent): boolean {
  const self = event.venue.accountId
  return (event.message ?? []).some((segment) => {
    if (segment.type !== 'mention') return false
    const userId = (segment.data as { userId?: unknown }).userId
    return typeof userId === 'string' && userId === self
  })
}

/** 附件服务是可选依赖：没有它，图片就退回成纯文本，消息照样送进去。 */
function resolveAttachments(ctx: Context): AttachmentsLike | undefined {
  try {
    const probe = ctx.root as unknown as { get?(name: string): unknown; attachments?: AttachmentsLike }
    return probe.attachments ?? (typeof probe.get === 'function' ? (probe.get('attachments') as AttachmentsLike | undefined) : undefined)
  } catch {
    return undefined
  }
}

/**
 * 信任表：主人和他信得过的人。
 *
 * 没有这个文件就是「谁都不信」—— 所有人在人格眼里都是 guest，只能聊天和问只读的东西。
 * 平台说谁是群主不算数：群主管得着那个群，管不着这台机器。
 */
async function readIdentity(dir: string): Promise<Identity> {
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : []

  try {
    const raw = JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8')) as {
      owners?: unknown
      trusted?: unknown
    }
    return { owners: list(raw.owners), trusted: list(raw.trusted) }
  } catch {
    return { owners: [], trusted: [] }
  }
}

/**
 * 人设三段：我是谁 / 什么时候说话 / 怎么说话。
 *
 * 分开写不是洁癖：混成一段时，想调「别太活跃」就会改到性格上去。三份都是可选的，
 * 一份都没有才回落到老的单文件 persona.md。
 */
const PERSONA_PARTS = [
  { file: 'personality.md', title: '我是谁' },
  { file: 'behavior.md', title: '什么时候说话' },
  { file: 'reply_style.md', title: '怎么说话' },
  // 例子比形容词管用：所有角色卡格式里 `mes_example` 都是核心字段。
  { file: 'examples.md', title: '举例：它平时是怎么说话的' },
]

/** 人格文本。没有这些文件就是空字符串 —— 人格只是没写自我介绍，不是坏了。 */
async function readPersonaText(dir: string): Promise<string> {
  const read = async (file: string): Promise<string> => {
    try {
      return (await readFile(join(dir, file), 'utf8')).trim()
    } catch {
      return ''
    }
  }

  const parts = await Promise.all(PERSONA_PARTS.map(async (part) => ({ ...part, text: await read(part.file) })))
  const filled = parts.filter((part) => part.text !== '')
  if (filled.length > 0) return filled.map((part) => `## ${part.title}\n${part.text}`).join('\n\n')

  return read('persona.md')
}

/** 模型三件套；provider 或 model 缺一个就不指定，交给部署默认。 */
function model(config: PersonaConfig): AgentModel | undefined {
  const provider = readField<string>(config.provider)
  const id = readField<string>(config.model)
  if (provider === undefined || provider === '' || id === undefined || id === '') return undefined
  const effort = readField<string>(config.reasoningEffort)
  return { provider, model: id, ...(effort === undefined || effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * 人格工作区：先让目录存在，再登记成 DSH 项目。
 *
 * 登记是尽力而为 —— 目录在，会话就能建；登记失败只是侧栏里少一个分组，
 * 不该让整条回复链断掉。
 */
async function prepareWorkspace(
  ctx: Context,
  dir: string,
  title: string,
  log: Logger,
  journal: Journal,
): Promise<WorkspaceRecordLike | undefined> {
  await mkdir(dir, { recursive: true })
  const registry = (ctx as unknown as { get(name: string): WorkspaceRegistryLike | undefined }).get('workspaceRegistry')
  if (registry === undefined) return undefined
  try {
    const canonical = await realpath(dir)
    const existing = registry.list().find((item) => item.path === canonical)
    if (existing !== undefined) {
      // 名字是算出来的，不是存出来的：改过命名规则之后，已有的记录跟着改。
      if (existing.title !== title) await existing.setTitle(title)
      return existing
    }
    await registry.create(canonical, title)
    journal.note('workspace', `登记人格工作区：${canonical}`)
    return registry.list().find((item) => item.path === canonical)
  } catch (error) {
    log.error('人格工作区登记失败：%s', String(error))
    journal.note('workspace', `人格工作区登记失败：${String(error)}`)
    return undefined
  }
}

/** 取不到就建一个。同一场所永远只会有一个 agent。 */
async function open(
  sessionId: string,
  agents: AgentsLike,
  live: Map<string, AgentLike>,
  dir: string,
  agentModel: AgentModel | undefined,
  log: Logger,
  workspace: WorkspaceRecordLike | undefined,
  attached: Set<string>,
  disposers: Map<string, () => void>,
  attachToWorkspace: boolean,
): Promise<AgentLike> {
  const existing = live.get(sessionId)
  if (existing !== undefined) return existing

  const created = agents.get(sessionId) === undefined ? await createOrResume(agents, sessionId, dir, agentModel, log) : undefined
  const agent = created?.agent ?? (agents.get(sessionId) as AgentLike)
  if (created?.dispose !== undefined) disposers.set(sessionId, created.dispose)
  live.set(sessionId, agent)

  if (attachToWorkspace && !attached.has(sessionId)) {
    attached.add(sessionId)
    // **不等它**：侧栏登记是给人看的，不该挡住回复。之前这里 await，workspace 一慢，
    // 整个场所的队列就卡住 —— 凌晨那批消息晚回了三个多小时，就是卡在这一行。
    Promise.resolve(workspace?.attachSession?.(sessionId))
      .then(() => undefined, () => undefined)
  }
  return agent
}

/**
 * 第一次用 create（这是唯一能带上 cwd 的入口），已经落过盘就恢复。
 *
 * 反过来（先 resume）会给新会话造出一个没有 cwd 的 header，落在 `_no-cwd` 里 ——
 * 人格就没有工作区了。
 */
async function createOrResume(
  agents: AgentsLike,
  sessionId: string,
  dir: string,
  agentModel: AgentModel | undefined,
  log: Logger,
): Promise<{ agent: AgentLike; dispose?: () => void }> {
  const options = agentModel === undefined ? {} : { agentOptions: agentModel }
  try {
    const handle = await agents.create({ sessionId, meta: { cwd: dir }, ...options })
    log.info('新场所会话 %s，cwd=%s', sessionId, dir)
    return { agent: handle.agent, dispose: (handle as { dispose?: () => void }).dispose }
  } catch (error) {
    if ((error as { name?: string } | undefined)?.name !== 'SessionAlreadyExistsError') throw error
    const handle = await agents.resume({ resumeSessionId: sessionId, ...options })
    return { agent: handle.agent }
  }
}
