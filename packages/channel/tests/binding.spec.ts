import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, realpath, stat } from 'node:fs/promises'
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
    const agent = { sessionId: id, calls, followup: (message: any) => { calls.push(message) } }
    this.live.set(id, agent)
    return agent
  }
}

/** 假的工作区登记处：只记下名字，够断言「侧栏里叫什么」。 */
class FakeWorkspaces extends Service {
  records: { path: string; title: string; setTitle(title: string): Promise<void> }[] = []
  created: string[] = []

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
    }
    this.records.push(record)
    return record
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

  async function boot(config: Record<string, unknown> = {}) {
    h = makeApp()
    await h.use(Channels)
    await h.use(fakeDriver)
    await h.use(FakeAgents)
    await h.use(FakeWorkspaces)
    await h.use(binding, config)
    return {
      driver: h.app.channels.getDriver('fake')!,
      agents: h.app.get('agents') as FakeAgents,
      workspaces: h.app.get('workspaceRegistry') as FakeWorkspaces,
    }
  }

  it('一个场所一个 agent：同群第二条消息复用', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', text: '第一条' })
    driver.simulateInbound({ conversationId: 'g1', text: '第二条' })
    await tick()

    expect(agents.created).toHaveLength(1)
    expect(agents.get('shixu-fake:bot:g1').calls).toHaveLength(2)
  })

  it('新场所的会话落在人格工作区里：cwd 是 persona/<id>，目录真的建出来', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', text: '你好' })
    await tick()

    const dir = join(home, 'persona', 'default')
    expect(agents.created[0].cwd).toBe(dir)
    // 目录不存在的话，会话 header 指向一个空洞 —— 产物与记忆都无处可放。
    await expect(stat(dir)).resolves.toBeTruthy()
  })

  it('人格 id 改了，工作区跟着走', async () => {
    const { driver, agents } = await boot({ personaId: 'arisu' })
    driver.simulateInbound({ conversationId: 'g1', text: '你好' })
    await tick()

    expect(agents.created[0].cwd).toBe(join(home, 'persona', 'arisu'))
  })

  it('工作区在侧栏里叫 时煦-<人格名>', async () => {
    const { driver, workspaces } = await boot({ personaId: 'arisu' })
    driver.simulateInbound({ conversationId: 'g1', text: '你好' })
    await tick()

    expect(workspaces.created).toEqual(['时煦-arisu'])
  })

  it('已有的工作区按新名字改名，不重复登记', async () => {
    const dir = await realpath(await mkdir(join(home, 'persona', 'default'), { recursive: true }).then(() => join(home, 'persona', 'default')))
    const { driver, workspaces } = await boot()
    const record = { path: dir, title: '人格 · default', setTitle: async (next: string) => { record.title = next } }
    workspaces.records.push(record)

    driver.simulateInbound({ conversationId: 'g1', text: '你好' })
    await tick()

    expect(workspaces.created).toHaveLength(0)
    expect(record.title).toBe('时煦-default')
  })

  it('已经落过盘的会话走恢复，不会被重建', async () => {
    const { driver, agents } = await boot()
    agents.persisted.add('shixu-fake:bot:g1')
    driver.simulateInbound({ conversationId: 'g1', text: '接着说' })
    await tick()

    expect(agents.created).toHaveLength(0)
    expect(agents.resumed).toEqual(['shixu-fake:bot:g1'])
  })

  it('关掉的场所不唤醒人格：不建 agent、不投递', async () => {
    const { driver, agents } = await boot({ mutedVenues: ['fake:bot:g1'] })
    driver.simulateInbound({ conversationId: 'g1', text: '在吗' })
    driver.simulateInbound({ conversationId: 'g2', text: '在吗' })
    await tick()

    expect(agents.created.map((one) => one.sessionId)).toEqual(['shixu-fake:bot:g2'])
  })

  it('配了模型就带上，没配就跟随默认', async () => {
    const explicit = await boot({ provider: 'openrouter', model: 'deepseek-v4.1-flash-oc' })
    explicit.driver.simulateInbound({ conversationId: 'g1', text: '你好' })
    await tick()
    expect(explicit.agents.created[0].model).toEqual({ provider: 'openrouter', model: 'deepseek-v4.1-flash-oc' })
    await h?.dispose()
    h = undefined

    const silent = await boot()
    silent.driver.simulateInbound({ conversationId: 'g1', text: '你好' })
    await tick()
    expect(silent.agents.created[0].model).toBeUndefined()
  })

  it('并发不乱序：同群两条同时到达，顺序与到达顺序一致', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', text: '先' })
    driver.simulateInbound({ conversationId: 'g1', text: '后' })
    await tick()

    const calls = agents.get('shixu-fake:bot:g1').calls
    expect(calls).toHaveLength(2)
    expect(calls[0].content[0].text).toMatch(/先$/)
    expect(calls[1].content[0].text).toMatch(/后$/)
  })

  it('不同场所各有自己的 agent', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', text: 'A 群' })
    driver.simulateInbound({ conversationId: 'g2', text: 'B 群' })
    await tick()

    expect(agents.created).toHaveLength(2)
    expect(agents.get('shixu-fake:bot:g1').calls[0].content[0].text).toMatch(/A 群/)
    expect(agents.get('shixu-fake:bot:g2').calls[0].content[0].text).toMatch(/B 群/)
  })

  it('来源事实走消息前缀（不进 source kind）', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', userId: 'u1', text: '你好' })
    await tick()

    const text = agents.get('shixu-fake:bot:g1').calls[0].content[0].text
    expect(text).toMatch(/^<dsh_source [^>]*venue="fake\/bot\/g1"/)
    expect(text).toMatch(/你好$/)
  })

  it('不是 message 的事件不唤醒人格（入群通知不该把人叫起来）', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', type: 'member', change: 'join' })
    await tick()
    expect(agents.created).toHaveLength(0)
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
