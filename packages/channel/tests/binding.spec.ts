import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Channels from '../lib/channels.js'
import * as fakeDriver from '../lib/driver-fake.js'
import * as binding from '../lib/binding.js'

/**
 * 假的 agents 服务：只实现绑定真正用到的三件事。
 * 形状对齐真实 dsh：create 收 meta.cwd，已经落过盘就抛 SessionAlreadyExistsError；
 * resume 只按 id 恢复；投递在 agent.followup(消息对象) 上。
 */
class FakeAgents extends Service {
  created: { sessionId: string; cwd?: string; model?: unknown }[] = []
  resumed: string[] = []
  persisted = new Set<string>()
  live = new Map<string, any>()
  /** agent 作用域上收到的东西：工具、闸门与提示词段。 */
  tools: any[] = []
  guards: any[] = []
  sections: any[] = []

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  async create({ sessionId, meta, agentOptions }: any) {
    if (this.persisted.has(sessionId)) {
      const error = new Error(`session "${sessionId}" already exists`)
      error.name = 'SessionAlreadyExistsError'
      throw error
    }
    this.persisted.add(sessionId)
    this.created.push({ sessionId, cwd: meta?.cwd, model: agentOptions })
    return { agent: this.spawn(sessionId), dispose: async () => {} }
  }

  async resume({ resumeSessionId }: any) {
    this.resumed.push(resumeSessionId)
    this.persisted.add(resumeSessionId)
    return { agent: this.live.get(resumeSessionId) ?? this.spawn(resumeSessionId) }
  }

  get(id: string) {
    return this.live.get(id)
  }

  spawn(id: string) {
    const calls: any[] = []
    const agent = {
      sessionId: id,
      calls,
      followup: (message: any) => {
        calls.push(message)
        // 真环境下这一轮会把消息记进会话（user/message），然后走完（turn/end）。
        queueMicrotask(() => {
          const root = this.ctx.root as any
          root.emit('session/event', { id }, { type: 'user/message', data: { message: { id: message.id } } })
          // 真环境里工具是在这一轮中途执行的，turn/end 在最后；这里留出这个窗口，
          // 免得测试还没验闸门，说话人就被清空了。
          setTimeout(() => root.emit('session/event', { id }, { type: 'turn/end', data: {} }), 400)
        })
      },
      ctx: {
        tools: {
          register: (definition: any) => { this.tools.push(definition); return () => {} },
          guard: (check: any) => { this.guards.push(check); return () => {} },
        },
        // 和真 API 一样：拿到的 off 调用后这一段就没了，重复注册等于替换。
        systemPrompt: {
          section: (section: any) => {
            this.sections.push(section)
            return () => {
              const index = this.sections.indexOf(section)
              if (index >= 0) this.sections.splice(index, 1)
            }
          },
        },
      },
    }
    this.live.set(id, agent)
    return agent
  }

  /** 按运行时的方式跑一遍闸门：第一个返回理由的赢，全放行就是 undefined。 */
  denial(exec: { name: string; arguments: Record<string, unknown> }): string | undefined {
    for (const guard of this.guards) {
      const reason = guard(exec)
      if (reason !== undefined && reason !== '') return reason
    }
    return undefined
  }
}

/** 假的工作区登记处：只记下名字，够断言「侧栏里叫什么」。 */
class FakeWorkspaces extends Service {
  records: { path: string; title: string; setTitle(title: string): Promise<void>; attachSession(id: string): Promise<void> }[] = []
  created: string[] = []
  attached: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'workspaceRegistry')
  }

  list() {
    return this.records
  }

  async create(path: string, title?: string) {
    this.created.push(title ?? '')
    const record = {
      path,
      title: title ?? '',
      setTitle: async (next: string) => { record.title = next },
      attachSession: async (id: string) => { this.attached.push(id) },
    }
    this.records.push(record)
    return record
  }
}

/** 假的附件服务：记下收到什么、回一个可辨认的引用。 */
class FakeAttachments extends Service {
  seen: any[] = []

  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  async admitPromptContent(content: any[]) {
    this.seen = content
    return content.map((part) => (part.type === 'image' ? { type: 'image', attachment: 'ref-1' } : part))
  }
}

/** 假的部署默认模型：人格没指定时应当读它。 */
class FakeDefaultModel extends Service {
  selection: { provider?: string; model?: string; reasoningEffort?: string } = {
    provider: 'openrouter',
    model: 'deepseek-v4.1-flash-oc',
    reasoningEffort: 'max',
  }

  constructor(ctx: Context) {
    super(ctx, 'agentDefaultModel')
  }

  currentSelection() {
    return this.selection
  }
}

const tick = () => new Promise((r) => setTimeout(r, 60))

/**
 * 破损类：**一条消息没能变成一轮对话**，或**变成了好几轮 / 乱序的几轮**，
 * 或**人格在一个它不该说话的地方说话了**。
 */
describe('场所 → agent 绑定', () => {
  let h: any
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'shixu-binding-'))
    process.env.DSH_HOME = home
  })

  afterEach(async () => {
    await h?.dispose()
    h = undefined
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  async function boot(config: Record<string, unknown> = {}, options: { defaultModel?: boolean; attachments?: boolean } = {}) {
    h = makeApp()
    await h.use(Channels)
    await h.use(fakeDriver)
    await h.use(FakeAgents)
    await h.use(FakeWorkspaces)
    if (options.defaultModel === true) await h.use(FakeDefaultModel)
    if (options.attachments === true) await h.use(FakeAttachments)
    // 测试不等打字延迟，也不拆消息；这两件事单独在 timing.spec 里验。
    await h.use(binding, { typingDelayMs: 0, replyMaxChunks: 1, ...config })
    return {
      driver: h.app.channels.getDriver('fake')!,
      agents: h.app.get('agents') as FakeAgents,
      workspaces: h.app.get('workspaceRegistry') as FakeWorkspaces,
      attachments: h.app.get('attachments') as FakeAttachments | undefined,
    }
  }

  it('一个场所一个 agent：同群第二条消息复用', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '第一条' })
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '第二条' })
    await tick()

    expect(agents.created).toHaveLength(1)
    expect(agents.get('shixu-fake:bot:g1').calls).toHaveLength(2)
  })

  it('新场所的会话落在人格工作区里：cwd 是 persona/<id>，目录真的建出来', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    const dir = join(home, 'persona', 'default')
    expect(agents.created[0].cwd).toBe(dir)
    // 目录不存在的话，会话 header 指向一个空洞 —— 产物与记忆都无处可放。
    await expect(stat(dir)).resolves.toBeTruthy()
  })

  it('人格 id 改了，工作区跟着走', async () => {
    const { driver, agents } = await boot({ personaId: 'arisu' })
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    expect(agents.created[0].cwd).toBe(join(home, 'persona', 'arisu'))
  })

  it('工作区在侧栏里叫 时煦-<人格名>', async () => {
    const { driver, workspaces } = await boot({ personaId: 'arisu' })
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    expect(workspaces.created).toEqual(['时煦-arisu'])
  })

  it('已有的工作区按新名字改名，不重复登记', async () => {
    const dir = await realpath(await mkdir(join(home, 'persona', 'default'), { recursive: true }).then(() => join(home, 'persona', 'default')))
    const { driver, workspaces } = await boot()
    const record = { path: dir, title: '人格 · default', setTitle: async (next: string) => { record.title = next } }
    workspaces.records.push(record)

    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    expect(workspaces.created).toHaveLength(0)
    expect(record.title).toBe('时煦-default')
  })

  it('已经落过盘的会话走恢复，不会被重建', async () => {
    const { driver, agents } = await boot()
    agents.persisted.add('shixu-fake:bot:g1')
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '接着说' })
    await tick()

    expect(agents.created).toHaveLength(0)
    expect(agents.resumed).toEqual(['shixu-fake:bot:g1'])
  })

  it('关掉的场所不唤醒人格：不建 agent、不投递', async () => {
    const { driver, agents } = await boot({ mutedVenues: ['fake:bot:g1'] })
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '在吗' })
    driver.simulateInbound({ conversationId: 'g2', mentions: ['bot'], text: '在吗' })
    await tick()

    expect(agents.created.map((one) => one.sessionId)).toEqual(['shixu-fake:bot:g2'])
  })

  it('配了模型就带上，没配就跟随默认', async () => {
    const explicit = await boot({ provider: 'openrouter', model: 'deepseek-v4.1-flash-oc' })
    explicit.driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()
    expect(explicit.agents.created[0].model).toEqual({ provider: 'openrouter', model: 'deepseek-v4.1-flash-oc' })
    await h?.dispose()
    h = undefined

    const silent = await boot()
    silent.driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()
    expect(silent.agents.created[0].model).toBeUndefined()
  })

  it('没指定模型就跟随部署默认：不然会话没有模型，每一轮都装配失败', async () => {
    const { driver, agents } = await boot({}, { defaultModel: true })
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    expect(agents.created[0].model).toEqual({
      provider: 'openrouter',
      model: 'deepseek-v4.1-flash-oc',
      reasoningEffort: 'max',
    })
  })

  it('人格自己指定的模型优先于部署默认', async () => {
    const { driver, agents } = await boot({ provider: 'gemini-lumiya', model: 'gemini-4-argon' }, { defaultModel: true })
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    expect(agents.created[0].model).toEqual({ provider: 'gemini-lumiya', model: 'gemini-4-argon' })
  })

  it('并发不乱序：同群两条同时到达，顺序与到达顺序一致', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '先' })
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '后' })
    await tick()

    const calls = agents.get('shixu-fake:bot:g1').calls
    expect(calls).toHaveLength(2)
    expect(calls[0].content[0].text).toMatch(/先$/)
    expect(calls[1].content[0].text).toMatch(/后$/)
  })

  it('不同场所各有自己的 agent', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: 'A 群' })
    driver.simulateInbound({ conversationId: 'g2', mentions: ['bot'], text: 'B 群' })
    await tick()

    expect(agents.created).toHaveLength(2)
    expect(agents.get('shixu-fake:bot:g1').calls[0].content[0].text).toMatch(/A 群/)
    expect(agents.get('shixu-fake:bot:g2').calls[0].content[0].text).toMatch(/B 群/)
  })

  it('来源事实走消息前缀（不进 source kind）', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', userId: 'u1', mentions: ['bot'], text: '你好' })
    await tick()

    const text = agents.get('shixu-fake:bot:g1').calls[0].content[0].text
    expect(text).toMatch(/^<dsh_source [^>]*venue="fake\/bot\/g1"/)
    expect(text).toMatch(/你好$/)
  })

  it('人格说的话回到原场所：一条 turn 只发一条', async () => {
    const { driver } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    const sessionId = 'shixu-fake:bot:g1'
    const say = (text: string) =>
      h.app.emit('session/event', { id: sessionId }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text }] } },
      })

    // 一次 turn 里两步：工具调用之后再说一句，用户等的是一条回复，不是两条。
    say('我查一下')
    say('查到了，是 42')
    h.app.emit('session/event', { id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: 'success' } })
    await tick()

    const sent = (driver as any).sent
    expect(sent).toHaveLength(1)
    expect(sent[0].action).toBe('send')
    // 默认不引用：一条回复就是一条正文。
    expect(sent[0].params.segments).toEqual([{ type: 'text', data: { text: '我查一下\n\n查到了，是 42' } }])
  })

  it('只调工具不说话的一轮，不往群里发空消息', async () => {
    const { driver } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    h.app.emit('session/event', { id: 'shixu-fake:bot:g1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool-call', name: 'echo' }] } },
    })
    h.app.emit('session/event', { id: 'shixu-fake:bot:g1' }, { type: 'turn/end', data: { turn: 1, reason: 'success' } })
    await tick()

    expect((driver as any).sent).toHaveLength(0)
  })

  it('别的会话说的话不会被发到这个场所', async () => {
    const { driver } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    h.app.emit('session/event', { id: 'shixu-fake:bot:g2' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '串台了' }] } },
    })
    h.app.emit('session/event', { id: 'shixu-fake:bot:g2' }, { type: 'turn/end', data: { turn: 1 } })
    await tick()

    expect((driver as any).sent).toHaveLength(0)
  })

  it('会话挂进人格工作区，侧栏里找得到', async () => {
    const { driver, workspaces } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    expect(workspaces.attached).toEqual(['shixu-fake:bot:g1'])
  })

  it('不是 message 的事件不唤醒人格（入群通知不该把人叫起来）', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', type: 'member', change: 'join' })
    await tick()
    expect(agents.created).toHaveLength(0)
  })

  /**
   * 破损类：**它在不该开口的时候开口**。
   * 用户看到：群里没人在叫它，它却逐条接话；或者它回自己一句，然后停不下来。
   */
  it('自己发的消息不唤醒自己（否则它回一句就再接一句）', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '我说的话', self: true })
    await tick()

    expect(agents.created).toHaveLength(0)
  })

  it('群里没 @ 它就不说话', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', text: '两个人自己聊' })
    await tick()

    expect(agents.created).toHaveLength(0)
  })

  it('@ 的是别人也不算叫它', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['u-other'], text: '问一下你' })
    await tick()

    expect(agents.created).toHaveLength(0)
  })

  it('私聊不用 @ 也会回', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'p1', conversationType: 'private', text: '在吗' })
    await tick()

    expect(agents.created.map((one) => one.sessionId)).toEqual(['shixu-fake:bot:p1'])
  })

  /**
   * 破损类：**模型手里没有工具**（人格只会聊天），或者**拿到了它不该自主执行的动作**。
   */
  it('动作目录变成这个场所的工具，执行会打到驱动', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    const echo = agents.tools.find((tool) => tool.name === 'fake_echo')
    expect(echo).toBeDefined()

    const result = await echo.execute({ text: 'hi' })
    expect(JSON.parse(result)).toEqual({ ok: true })
    expect(driver.sent.at(-1)?.params).toMatchObject({ text: 'hi' })
  })

  it('persona.md 变成一条系统提示段', async () => {
    const dir = join(home, 'persona', 'default')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'persona.md'), '我是时煦，说话简短。', 'utf8')

    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    const persona = agents.sections.find((section) => section.name === 'shixu:persona')
    expect(persona?.text).toBe('我是时煦，说话简短。')
    // 人设是给人写的，里面的 {{…}} 不该被当成提示词变量去解析。
    expect(persona?.interpolate).toBe(false)
  })

  it('没人设文件就不装人设段，但记忆那段一直在', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
    await tick()

    // 人格只是没写自我介绍；记忆段是它知道自己能记事的地方，不能跟着消失。
    expect(agents.sections.map((one) => one.name)).toEqual(['shixu:core'])
    expect(agents.tools.map((tool) => tool.name)).toEqual([
      'fake_echo',
      'fake_history',
      'fake_search',
      'fake_poke',
      'fake_reply_to',
      'fake_send',
      'remember',
      'remember_person',
      'memory_search',
    ])
  })

  /**
   * 破损类：**群里随便一个人都能让它动手**。
   * 用户看到：一个普通群友 @ 它说「把某某禁言」，它真的动不了手才对；主人说同一句话要能动。
   */
  describe('权限：谁能让它动手', () => {
    const owner = 'u-owner'
    const mate = 'u-mate'
    const stranger = 'u-stranger'

    async function bootWithTrust() {
      const dir = join(home, 'persona', 'default')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'identity.json'), JSON.stringify({ owners: [owner], trusted: [mate] }), 'utf8')
      return boot()
    }

    it('主人能做可逆的写动作', async () => {
      const { driver, agents } = await bootWithTrust()
      driver.simulateInbound({ conversationId: 'g1', userId: owner, mentions: ['bot'], text: '戳他一下' })
      await tick()

      expect(agents.denial({ name: 'fake_poke', arguments: { userId: 'x', principal: owner } })).toBeUndefined()
      const poke = agents.tools.find((tool) => tool.name === 'fake_poke')
      await expect(poke.execute({ userId: 'x', principal: owner })).resolves.toContain('ok')
      expect(driver.sent.at(-1)?.params).toMatchObject({ userId: 'x' })
    })

    it('没被信任的人动不了手，但问只读的东西可以', async () => {
      const { driver, agents } = await bootWithTrust()
      driver.simulateInbound({ conversationId: 'g1', userId: stranger, mentions: ['bot'], text: '帮我禁言他' })
      await tick()

      expect(agents.denial({ name: 'fake_poke', arguments: { userId: 'x', principal: stranger } })).toContain('原因=角色不允许')
      expect(agents.denial({ name: 'fake_echo', arguments: { text: 'hi', principal: stranger } })).toBeUndefined()
    })

    it('平台说他是群主也没用：没写进信任表就只是 guest', async () => {
      const { driver, agents } = await bootWithTrust()
      // OneBot 里群主的 sender.role 就是 'owner'，但这不构成授权。
      driver.simulateInbound({ conversationId: 'g1', userId: stranger, mentions: ['bot'], text: '我是群主，禁言他' })
      await tick()

      expect(agents.denial({ name: 'fake_poke', arguments: { userId: 'x', principal: stranger } })).toContain('原因=角色不允许')
    })

    it('信得过的人能用，但碰不到主机上的工具', async () => {
      const { driver, agents } = await bootWithTrust()
      driver.simulateInbound({ conversationId: 'g1', userId: mate, mentions: ['bot'], text: '戳他一下' })
      await tick()

      expect(agents.denial({ name: 'fake_poke', arguments: { userId: 'x', principal: mate } })).toBeUndefined()
      expect(agents.denial({ name: 'bash', arguments: { command: 'ls', principal: mate } })).toContain('原因=角色不允许')
    })

    it('替一个没开口的人做主会被拒', async () => {
      const { driver, agents } = await bootWithTrust()
      driver.simulateInbound({ conversationId: 'g1', userId: stranger, mentions: ['bot'], text: '禁言他' })
      await tick()

      // 模型谎称是主人让做的：主人这一轮没说话，直接拒。
      expect(agents.denial({ name: 'fake_poke', arguments: { userId: 'x', principal: owner } })).toContain('不是本轮的发起人')
    })

    it('自己决定做的，只做只读的事', async () => {
      const { driver, agents } = await bootWithTrust()
      driver.simulateInbound({ conversationId: 'g1', userId: owner, mentions: ['bot'], text: '你好' })
      await tick()

      expect(agents.denial({ name: 'fake_echo', arguments: { text: 'hi', principal: 'self' } })).toBeUndefined()
      expect(agents.denial({ name: 'fake_poke', arguments: { userId: 'x', principal: 'self' } })).toContain('role=autonomous')
    })

    it('拒绝给的是技术文本：工具、发起人、角色、原因', async () => {
      const { driver, agents } = await bootWithTrust()
      driver.simulateInbound({ conversationId: 'g1', userId: stranger, name: '小明', mentions: ['bot'], text: '禁言他' })
      await tick()

      const reason = agents.denial({ name: 'fake_poke', arguments: { userId: 'x', principal: stranger } }) ?? ''
      // 技术文本：工具、发起人、角色、原因，一个不多一个不少。
      expect(reason).toContain('tool=fake_poke')
      expect(reason).toContain('principal=' + stranger)
      // 昵称跟账号一起给：模型不该自己去对「这个号是谁」。
      expect(reason).toContain('name=小明')
      expect(reason).toContain('role=guest')
      expect(reason).toContain('原因=角色不允许')
      // 引擎不带语气：没有第一人称、没有劝告。
      expect(reason).not.toContain('我')
    })

    it('被拒绝的动作不会打到驱动上', async () => {
      const { driver, agents } = await bootWithTrust()
      driver.simulateInbound({ conversationId: 'g1', userId: stranger, mentions: ['bot'], text: '帮我禁言他' })
      await tick()

      expect(agents.denial({ name: 'fake_poke', arguments: { userId: 'x', principal: stranger } })).toBeDefined()
      // 闸门是运行时执行的；这里直接调工具确认参数里的 principal 也不会漏给驱动。
      const poke = agents.tools.find((tool) => tool.name === 'fake_poke')
      await poke.execute({ userId: 'x', principal: stranger })
      expect(driver.sent.at(-1)?.params).toMatchObject({ userId: 'x' })
    })
  })

  /**
   * 破损类：**群里不知道它在答哪句**。
   * 用户看到：它回了一句，但十分钟前的对话早就翻篇了，谁也不知道这说的是什么。
   */
  /**
   * 破损类：**同一个人的小号被当成陌生人** —— 换个号进来，它立刻「你谁啊」。
   */
  describe('认人：小号也是同一个人', () => {
    it('记过某人之后，他换账号说话时它先想起他', async () => {
      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', userId: 'u-main', name: '老王', mentions: ['bot'], text: '在吗' })
      await tick()

      const rememberPerson = agents.tools.find((tool) => tool.name === 'remember_person')
      await rememberPerson.execute({ person: '老王', text: '在华理读书', principal: 'u-owner' })

      // 换个账号进来（同一个名字）：模型看到的是关于这个名字的记忆，而不是「你谁啊」。
      driver.simulateInbound({ conversationId: 'g1', userId: 'u-alt', name: '老王', mentions: ['bot'], text: '我换号了' })
      await tick()

      const content = JSON.stringify(agents.live.get('shixu-fake:bot:g1')?.calls.at(-1))
      expect(content).toContain('老王')
      expect(content).toContain('在华理读书')
    })

    it('陌生人不硬套：没有记忆就当普通人', async () => {
      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', userId: 'u-unknown', name: '路人', mentions: ['bot'], text: '在吗' })
      await tick()

      const content = JSON.stringify(agents.live.get('shixu-fake:bot:g1')?.calls.at(-1))
      expect(content).not.toContain('你记下的')
    })
  })

  /**
   * 破损类：**它永远在第一天** —— 聊过的事转头就忘，每次都要重新自我介绍。
   */
  describe('它自己的记忆', () => {
    it('记下的事以后查得到', async () => {
      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '记一下：主人叫陈旭' })
      await tick()

      const remember = agents.tools.find((tool) => tool.name === 'remember')
      await remember.execute({ text: '主人叫陈旭', principal: 'u-owner' })

      const search = agents.tools.find((tool) => tool.name === 'memory_search')
      const found = await search.execute({ query: '陈旭', principal: 'u-owner' })
      expect(found).toContain('主人叫陈旭')
    })

    it('一个群里记的事，在另一个群也查得到', async () => {
      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '记一下' })
      await tick()
      driver.simulateInbound({ conversationId: 'g2', mentions: ['bot'], text: '还记得吗' })
      await tick()

      const remember = agents.tools.find((tool) => tool.name === 'remember')
      await remember.execute({ text: '老王养了只猫叫咪咪', principal: 'u-owner' })

      // 换到 g2 的 agent 上查：全局一份，不该按群隔离。
      const other = agents.live.get('shixu-fake:bot:g2')
      const search = other?.tools?.find((tool: any) => tool.name === 'memory_search') ?? agents.tools.find((tool) => tool.name === 'memory_search')
      const found = await search.execute({ query: '咪咪', principal: 'u-owner' })
      expect(found).toContain('咪咪')
    })
  })

  /**
   * 破损类：**一眼是机器人** —— 一问就秒回一大段，或者一条回复拆成八条轰炸。
   */
  describe('说话的节奏', () => {
    it('长回复拆成几条发，短回复不拆', async () => {
      const { driver, agents } = await boot({ replyMaxChunks: 3 })
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '讲讲' })
      await tick()

      const root = (agents as any).ctx.root as any
      root.emit('session/event', { id: 'shixu-fake:bot:g1' }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '第一句。第二句。第三句。' }] } },
      })
      root.emit('session/event', { id: 'shixu-fake:bot:g1' }, { type: 'turn/end', data: {} })
      await new Promise((resolve) => setTimeout(resolve, 60))

      const sends = driver.sent.filter((call) => call.action === 'send')
      // 三条句子最多拆成三条，且拼回去是原话。
      expect(sends.length).toBeGreaterThan(1)
      expect(sends.length).toBeLessThanOrEqual(3)
      const joined = sends.map((call: any) => call.params.segments.map((one: any) => one.data.text ?? '').join('')).join('')
      expect(joined).toBe('第一句。第二句。第三句。')
    })
  })

  describe('引用回复', () => {
    /** 让这一轮「说完」并把回复投出去。 */
    async function speak(agents: FakeAgents, id: string): Promise<void> {
      const root = (agents as any).ctx.root as any
      root.emit('session/event', { id }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好' }] } } })
      root.emit('session/event', { id }, { type: 'turn/end', data: {} })
      await new Promise((resolve) => setTimeout(resolve, 30))
    }

    it('默认不引用：真人不每句都挂回原消息', async () => {
      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '看看这个' })
      await tick()
      await speak(agents, 'shixu-fake:bot:g1')

      const sent = driver.sent.find((call) => call.action === 'send') as any
      expect(sent.params.segments).toHaveLength(1)
      expect(sent.params.segments[0].type).toBe('text')
    })

    it('主人说要引用时才引用', async () => {
      const { driver, agents } = await boot({ quote: 'always' })
      const event = driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '看看这个' })
      await tick()
      await speak(agents, 'shixu-fake:bot:g1')

      const sent = driver.sent.find((call) => call.action === 'send') as any
      expect(sent.params.segments[0]).toEqual({ type: 'quote', data: { messageId: event.messageId } })
      expect(sent.params.segments[1].type).toBe('text')
    })

    it('答的不是最新那条时，when-older 才引用', async () => {
      const { driver, agents } = await boot({ quote: 'when-older' })
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '这个报错怎么修' })
      await tick()
      // 它还在想的时候，群里又说了两句 —— 这时候不引用，没人知道它在答哪句。
      driver.simulateInbound({ conversationId: 'g1', text: '另外那个呢' })
      await tick()
      await speak(agents, 'shixu-fake:bot:g1')

      const sent = driver.sent.find((call) => call.action === 'send') as any
      expect(sent.params.segments[0].type).toBe('quote')
    })

    it('模型自己指定挂哪条：它调了 reply_to 就照它说的', async () => {
      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '看看这个' })
      await tick()

      const replyTo = agents.tools.find((tool) => tool.name === 'fake_reply_to')
      expect(replyTo).toBeDefined()
      await replyTo.execute({ messageId: 'm-old', principal: 'u-test' })

      await speak(agents, 'shixu-fake:bot:g1')
      const sent = driver.sent.find((call) => call.action === 'send') as any
      expect(sent.params.segments[0]).toEqual({ type: 'quote', data: { messageId: 'm-old' } })
    })

    it('模型能直接发一条，不用等这一轮结束', async () => {
      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
      await tick()

      const sendNow = agents.tools.find((tool) => tool.name === 'fake_send')
      await sendNow.execute({ text: '我先说一句', principal: 'u-test' })

      const sent = driver.sent.find((call) => call.action === 'send') as any
      expect(sent.params.segments).toEqual([{ type: 'text', data: { text: '我先说一句' } }])
    })

    it('模型能查这个会话最近说了什么，带消息 id', async () => {
      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', text: '老王说了句什么' })
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '总结一下' })
      await tick()

      const history = agents.tools.find((tool) => tool.name === 'fake_history')
      const text = await history.execute({ limit: 5, principal: 'u-test' })
      // 驱动负责把平台报文归一化成「id + 谁 + 说了什么」。
      expect(text).toContain('m-1')
      expect(text).toContain('老王')
    })

    it('私聊不引用：一来一回本来就没有歧义', async () => {
      const { driver, agents } = await boot({ quote: 'always' })
      driver.simulateInbound({ conversationId: 'p1', conversationType: 'private', text: '在吗' })
      await tick()
      await speak(agents, 'shixu-fake:bot:p1')

      const sent = driver.sent.find((call) => call.action === 'send') as any
      expect(sent.params.segments).toHaveLength(1)
    })
  })

  /**
   * 破损类：**它在群里不存在** —— 不是被点名就是掉线，中间没有第三种状态。
   */
  describe('在场：先听见，再决定接不接', () => {
    it('没 @ 但打了名字也算在叫它', async () => {
      const { driver, agents } = await boot({ aliasNames: ['时煦'] })
      driver.simulateInbound({ conversationId: 'g1', text: '时煦，你来看看这个' })
      await tick()

      expect(agents.created).toHaveLength(1)
    })

    it('没叫它的消息攒成一批，交给判官，不叫醒它', async () => {
      const { driver, agents } = await boot({ aliasNames: ['时煦'], judgeWindowMs: 50 })
      driver.simulateInbound({ conversationId: 'g1', text: '今天好热' })
      driver.simulateInbound({ conversationId: 'g1', text: '是啊，三十八度' })
      // 判官是一个后台会话，要等它「说完」我们才记日志。
      await new Promise((resolve) => setTimeout(resolve, 700))

      // 判官自己会开一个后台会话，但场所里的人没被叫醒。
      expect(agents.created).not.toContain('shixu-fake:bot:g1')
      const log = await readFile(join(home, 'persona', 'default', 'logs', 'shixu.log'), 'utf8')
      // 一批两条一起去问判官，而不是一条一判。
      expect(log).toContain('判官')
      expect(log).toContain('积压=2')
    })

    it('人设三段分别进提示词：我是谁 / 什么时候说话 / 怎么说话', async () => {
      const dir = join(home, 'persona', 'default')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'personality.md'), '我是时煦。', 'utf8')
      await writeFile(join(dir, 'behavior.md'), '群里热闹时少说话。', 'utf8')
      await writeFile(join(dir, 'reply_style.md'), '说话短。', 'utf8')
      await writeFile(join(dir, 'examples.md'), '别人：在吗\n时煦：在。', 'utf8')

      const { driver, agents } = await boot()
      driver.simulateInbound({ conversationId: 'g1', mentions: ['bot'], text: '你好' })
      await tick()

      const section = agents.sections.find((one) => one.name === 'shixu:persona')
      expect(section?.text).toContain('## 我是谁')
      expect(section?.text).toContain('## 什么时候说话')
      expect(section?.text).toContain('群里热闹时少说话。')
      expect(section?.text).toContain('## 怎么说话')
      // 例子单独一段，跟在最后。
      expect(section?.text).toContain('## 举例')
      expect(section?.text).toContain('时煦：在。')
    })
  })

  /**
   * 破损类：**发了一张图，人格却只看到「[image]」**。
   * 用户看到：截图问它问题，它答非所问，因为它压根没看见图。
   */
  it('图片先落成附件，再作为图片块进消息', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) })
      response.end(png)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port

    try {
      const { driver, agents, attachments } = await boot({}, { attachments: true })
      driver.simulateInbound({
        conversationId: 'g1',
        mentions: ['bot'],
        text: '这张图里是什么',
        images: ['http://127.0.0.1:' + port + '/a.png'],
      })
      await tick()

      const content = agents.get('shixu-fake:bot:g1').calls[0].content
      expect(content).toHaveLength(2)
      expect(content[0].type).toBe('text')
      expect(content[1]).toEqual({ type: 'image', attachment: 'ref-1' })
      // 交给附件服务的是 base64 与认出来的类型，不是一个地址。
      expect(attachments?.seen[1]).toMatchObject({ type: 'image', mediaType: 'image/png' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('取不到图就退回纯文本，不让一张坏图吞掉整条消息', async () => {
    const { driver, agents, attachments } = await boot({}, { attachments: true })
    driver.simulateInbound({
      conversationId: 'g1',
      mentions: ['bot'],
      text: '图挂了',
      images: ['http://127.0.0.1:1/never.png'],
    })
    await tick()

    const content = agents.get('shixu-fake:bot:g1').calls[0].content
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('text')
    expect(attachments?.seen).toHaveLength(0)

    // 失败要留现场：人格目录下的日志里得有这条，否则出问题又只能靠猜。
    await new Promise((resolve) => setTimeout(resolve, 120))
    const written = await readFile(join(home, 'persona', 'default', 'logs', 'shixu.log'), 'utf8')
    expect(written).toContain('image')
    expect(written).toContain('never.png')
  })
})

function makeApp() {
  const app = new Context()
  const fibers: any[] = []
  return {
    app,
    async use(plugin: any, config?: unknown) {
      const fiber: any = await app.plugin(plugin, config as any)
      fibers.push(fiber)
      return fiber
    },
    async dispose() {
      for (const fiber of fibers.reverse()) {
        try { await fiber.dispose() } catch {}
      }
    },
  }
}
