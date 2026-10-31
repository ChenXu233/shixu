import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Channels from '../dist/channels.js'
import * as fakeDriver from '../dist/driver-fake.js'

/**
 * 破损类：**驱动活着却不能用**，或**驱动卸了还阴魂不散**。
 * 用户看到：热重载之后同一条群消息被处理两遍；或换了驱动还收到旧驱动的消息。
 */
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

describe('channels 注册表', () => {
  let h: ReturnType<typeof makeApp>

  afterEach(async () => await h?.dispose())

  it('注册即可用', async () => {
    h = makeApp()
    await h.use(Channels)
    await h.use(fakeDriver)
    expect(h.app.channels.listDrivers().map((d) => d.id)).toEqual(['fake'])
  })

  it('卸载即消失', async () => {
    h = makeApp()
    await h.use(Channels)
    const fiber: any = await h.use(fakeDriver)
    expect(h.app.channels.getDriver('fake')).toBeDefined()

    await fiber.dispose()
    expect(h.app.channels.getDriver('fake')).toBeUndefined()
  })

  it('幽灵事件：驱动卸载后晚到的消息不许再扇出', async () => {
    h = makeApp()
    await h.use(Channels)
    const fiber: any = await h.use(fakeDriver)
    const driver = h.app.channels.getDriver('fake')!
    let delivered = 0
    h.app.on('channels/event', () => { delivered++ })

    driver.simulateInbound({ conversationId: 'g1', text: '卸载前' })
    await fiber.dispose()
    // 驱动对象仍持有 socket 回调；卸载后它还可能送来最后一条消息。
    driver.simulateInbound({ conversationId: 'g1', text: '卸载后' })

    expect(delivered).toBe(1)
  })

  it('同一 id 注册两次必须报错，而不是悄悄覆盖', async () => {
    h = makeApp()
    await h.use(Channels)
    await h.use(fakeDriver)
    expect(() => h.app.channels.registerDriver(h.app.channels.getDriver('fake')!)).toThrow(/已经注册过/)
  })

  it('没有 driver 的会话发送必须报错，而不是静默丢消息', async () => {
    h = makeApp()
    await h.use(Channels)
    await expect(
      h.app.channels.send(
        { key: 'x:y:z', platform: 'x', accountId: 'y', conversationId: 'z', conversationType: 'group' },
        [],
      ),
    ).rejects.toThrow(/没有处理 "x" 的 driver/)
  })
})
