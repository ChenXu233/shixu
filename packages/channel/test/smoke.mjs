import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import Channels from '../dist/channels.js'
import * as fakeDriver from '../dist/driver-fake.js'
import * as binding from '../dist/binding.js'

/** 假的 agents 服务：只实现绑定真正用到的两件事。 */
class FakeAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents')
    this.created = []
    this.handles = new Map()
  }
  async create({ sessionId }) {
    if (this.handles.has(sessionId)) throw new Error('session 已存在：' + sessionId)
    const calls = []
    const handle = {
      sessionId,
      calls,
      followup: async (input) => { calls.push(input) },
    }
    this.created.push(sessionId)
    this.handles.set(sessionId, handle)
    return handle
  }
  get(id) {
    return this.handles.get(id)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

// ── 1. 内核 + driver：一条完整的最小组合 ──────────────────────────────
const app = new Context()
await app.plugin(Channels)
await app.plugin(fakeDriver)

assert.deepEqual(app.channels.listDrivers().map((d) => d.id), ['fake'], 'driver 应已注册')

const seen = []
app.on('channels/event', (event) => seen.push(event))
const driver = app.channels.getDriver('fake')
driver.simulateInbound({ conversationId: 'g1', userId: 'u1', text: '你好' })
assert.equal(seen.length, 1, '事件应被扇出一次')
assert.equal(seen[0].text, '你好')
assert.equal(seen[0].self.platform, 'fake')

// 出站：内核按会话路由回同一个 driver，不需要认识 fake
const session = {
  key: 'fake:bot:g1',
  platform: 'fake',
  accountId: 'bot',
  conversationId: 'g1',
  conversationType: 'group',
}
await app.channels.send(session, [{ type: 'text', data: { text: '收到' } }])
assert.equal(app.channels.fake.sent.length, 1, '应有一次出站调用')
assert.equal(app.channels.fake.sent[0].action, 'send')

// 没有 driver 的会话必须报错，不能静默丢消息
await assert.rejects(
  () => app.channels.send({ ...session, platform: 'nope', key: 'nope:bot:g1' }, []),
  /没有处理 "nope" 的 driver/,
)

// ── 2. 绑定：事件 → 一轮对话 ────────────────────────────────────────
await app.plugin(FakeAgents)
const agents = app.get('agents')
await app.plugin(binding)

driver.simulateInbound({ conversationId: 'g1', userId: 'u1', text: '你好' })
driver.simulateInbound({ conversationId: 'g1', userId: 'u2', text: '在吗' })
driver.simulateInbound({ conversationId: 'g2', userId: 'u1', text: '另一个群' })
await tick()

assert.equal(agents.created.length, 2, '两个场所应各建一个 agent；同群的第二条消息复用')
const g1 = agents.get('shixu-fake:bot:g1')
const g2 = agents.get('shixu-fake:bot:g2')
assert.equal(g1.calls.length, 2, '同群两条消息投给同一个 agent')
assert.equal(g2.calls.length, 1, '另一个群有自己的 agent')
assert.match(g1.calls[0].content[0].text, /<dsh_source [^>]*venue="fake\/bot\/g1"/, '来源事实走消息前缀')
assert.match(g1.calls[0].content[0].text, /你好$/, '原文保留在前缀之后')

console.log('OK: channels 缝跑通（driver 注册 / 事件扇出 / 出站路由 / 错误不静默 / 一场所一 agent）')
