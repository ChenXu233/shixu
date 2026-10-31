import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Channels from '../dist/channels.js'
import * as fakeDriver from '../dist/driver-fake.js'

// 1. 内核 + 一个 driver，就是一条完整的最小组合。
const app = new Context()
await app.plugin(Channels)
await app.plugin(fakeDriver)

assert.deepEqual(app.channels.listDrivers().map((d) => d.id), ['fake'], 'driver 应已注册')

// 2. 入站：driver → 内核 → 任意消费者。
const seen = []
app.on('channels/event', (event) => seen.push(event))
const driver = app.channels.getDriver('fake')
driver.simulateInbound({ conversationId: 'g1', userId: 'u1', text: '你好' })
assert.equal(seen.length, 1, '事件应被扇出一次')
assert.equal(seen[0].text, '你好')
assert.equal(seen[0].self.platform, 'fake')

// 3. 出站：内核按会话路由回同一个 driver，不需要认识 fake。
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

// 4. 没有 driver 的会话必须报错，不能静默丢消息。
await assert.rejects(
  () => app.channels.send({ ...session, platform: 'nope', key: 'nope:bot:g1' }, []),
  /没有处理 "nope" 的 driver/,
)

console.log('OK: channels 缝跑通（driver 注册 / 事件扇出 / 出站路由 / 缺 driver 报错）')
