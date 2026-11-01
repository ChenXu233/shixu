import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Channels from '../lib/channels.js'
import * as fakeDriver from '../lib/driver-fake.js'
import * as binding from '../lib/binding.js'

/** 假的 agents 服务：只实现绑定真正用到的两件事（create / get）。 */
class FakeAgents extends Service {
  created: string[] = []
  handles = new Map<string, any>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  async create({ sessionId }: { sessionId: string }) {
    if (this.handles.has(sessionId)) throw new Error('session 已存在：' + sessionId)
    const calls: any[] = []
    const handle = { sessionId, calls, followup: async (input: any) => { calls.push(input) } }
    this.created.push(sessionId)
    this.handles.set(sessionId, handle)
    return handle
  }

  get(id: string) {
    return this.handles.get(id)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30))

/**
 * 破损类：**一条消息没能变成一轮对话**，或**变成了好几轮 / 乱序的几轮**。
 * 用户看到：群里问一句人格不回；或它把两句话的先后顺序搞反，答非所问。
 */
describe('场所 → agent 绑定', () => {
  let h: any

  afterEach(async () => await h?.dispose())

  async function boot() {
    h = makeApp()
    await h.use(Channels)
    await h.use(fakeDriver)
    await h.use(FakeAgents)
    await h.use(binding)
    return { driver: h.app.channels.getDriver('fake')!, agents: h.app.get('agents') as FakeAgents }
  }

  it('一个场所一个 agent：同群第二条消息复用', async () => {
    const { driver, agents } = await boot()
    driver.simulateInbound({ conversationId: 'g1', text: '第一条' })
    driver.simulateInbound({ conversationId: 'g1', text: '第二条' })
    await tick()

    expect(agents.created).toHaveLength(1)
    expect(agents.get('shixu-fake:bot:g1').calls).toHaveLength(2)
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
    async use(plugin: any) {
      const fiber: any = await app.plugin(plugin)
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
