import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Channels from '../dist/channels.js'
import * as fakeDriver from '../dist/driver-fake.js'

/** 第二条协议的驱动：只记录自己收到的出站调用。 */
const probeCalls: unknown[] = []

function probeDriver() {
  return {
    name: 'driver-probe',
    inject: ['channels'],
    apply(ctx: any) {
      ctx.channels.registerDriver({
        protocol: 'probe',
        label: '探针驱动',
        actions: [],
        capabilities: (fakeDriver as any).capabilities,
        onEvent() {},
        async call(_action: string, params: unknown) {
          probeCalls.push(params)
          return { ok: true }
        },
      })
    },
  }
}

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
    expect(h.app.channels.listDrivers().map((d) => d.protocol)).toEqual(['fake'])
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

  it('同一协议注册两次必须报错，而不是悄悄覆盖', async () => {
    h = makeApp()
    await h.use(Channels)
    await h.use(fakeDriver)
    expect(() => h.app.channels.registerDriver(h.app.channels.getDriver('fake')!)).toThrow(/已经注册过/)
  })

  it('没有 driver 的协议发送必须报错，而不是静默丢消息', async () => {
    h = makeApp()
    await h.use(Channels)
    await expect(
      h.app.channels.send(
        {
          key: 'qq:bot:g1',
          protocol: 'onebot11',
          venue: { platform: 'qq', accountId: 'bot', conversationId: 'g1' },
          conversationType: 'group',
        },
        [],
      ),
    ).rejects.toThrow(/没有处理协议 "onebot11" 的 driver/)
  })

  /**
   * 破损类：**同一个平台开两条协议，消息走错线缆**。
   * 用户看到：官方 API 的群，回复从另一个号发出去；或者干脆发不出去。
   */
  it('同一平台两条协议：各走各的线缆', async () => {
    h = makeApp()
    probeCalls.length = 0
    await h.use(Channels)
    await h.use(fakeDriver)
    await h.use(probeDriver())

    // 两条会话的 platform 完全一样，只有 protocol 不同 —— 路由键错了这个用例就炸。
    const session = (protocol: string) => ({
      key: 'qq:bot:g1',
      protocol,
      venue: { platform: 'qq', accountId: 'bot', conversationId: 'g1' },
      conversationType: 'group' as const,
    })

    await h.app.channels.send(session('fake'), [{ type: 'text', data: { text: 'OneBot' } }])
    await h.app.channels.send(session('probe'), [{ type: 'text', data: { text: '官方 API' } }])

    expect((h.app.channels as any).fake.sent).toHaveLength(1)
    expect(probeCalls).toHaveLength(1)
  })

  it('协议由内核盖章：驱动在事件里塞 protocol 不生效', async () => {
    h = makeApp()
    await h.use(Channels)
    let emit: any
    await h.use({
      name: 'driver-forger',
      inject: ['channels'],
      apply(ctx: any) {
        ctx.channels.registerDriver({
          protocol: 'real',
          label: '伪造者',
          actions: [],
          capabilities: (fakeDriver as any).capabilities,
          onEvent(next: any) { emit = next },
          async call() { return { ok: true } },
        })
      },
    })

    const seen: any[] = []
    h.app.on('channels/event', (event) => seen.push(event))
    emit({
      id: '1',
      type: 'message',
      venue: { platform: 'qq', accountId: 'bot', conversationId: 'g1' },
      conversationType: 'group',
      self: false,
      timestamp: 0,
      raw: null,
      protocol: 'forged',
    })

    expect(seen[0].protocol).toBe('real')
  })
})
