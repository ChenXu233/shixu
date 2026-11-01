import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'
import Channels from 'dsh-shixu-channel'
import * as driver from '../lib/index.js'

/**
 * 破损类：**配了正向却连不出去，或反向的部署被正向才需要的字段挡住**。
 *
 * 用户看到的是「装了插件，一个事件都没有」。所以这里不测 apply 里调了谁，
 * 而是真的起一个插件、看对方有没有收到连接、看缺字段时报错说不说得清。
 */

let peer: WebSocketServer | undefined
const fibers: { dispose(): unknown }[] = []

afterEach(async () => {
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
  const closing = peer
  peer = undefined
  closing?.clients.forEach((socket) => socket.terminate())
  if (closing !== undefined) await new Promise<void>((resolve) => closing.close(() => resolve()))
})

/** 起一个本地 WS 服务冒充对方的 WS 服务端（NapCat 正向 WS）。 */
async function startPeer(): Promise<{ url: string; headers: IncomingHttpHeaders[]; connected: Promise<void> }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  peer = server
  const headers: IncomingHttpHeaders[] = []
  const connected = new Promise<void>((resolve) => {
    server.on('connection', (_socket, request) => {
      headers.push(request.headers)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return { url: `ws://127.0.0.1:${port}`, headers, connected }
}

/** 起一个带渠道内核的空应用 —— 驱动 inject 的是 channels，没有内核它根本不会激活。 */
async function makeApp(): Promise<Context> {
  const ctx = new Context()
  fibers.push(await ctx.plugin(Channels))
  return ctx
}

describe('按配置选连接方向', () => {
  it('正向模式缺 url：报错里说得出缺的是 url', async () => {
    const ctx = await makeApp()
    let failure: unknown
    try {
      await ctx.plugin(driver, { mode: 'forward' })
    } catch (error) {
      failure = error
    }
    // 断言消息而不是断言「有没有抛」：使用者看到的正是这句话。
    expect(String((failure as Error | undefined)?.message)).toContain('url')
  })

  it('反向模式不读 url：没填也能起来', async () => {
    const ctx = await makeApp()
    // 端口给 0 让系统分配，免得测试之间抢同一个端口。
    const fiber = await ctx.plugin(driver, { mode: 'reverse', port: 0 })
    fibers.push(fiber)

    expect(ctx.channels.getDriver('onebot11')?.label).toContain('反向')
    await fiber.dispose()
  })

  it('正向模式主动连对方，并带上配置里的令牌', async () => {
    const { url, headers, connected } = await startPeer()
    const ctx = await makeApp()

    const fiber = await ctx.plugin(driver, { mode: 'forward', url, accessToken: 'k' })
    fibers.push(fiber)

    await connected
    expect(headers[0]?.authorization).toBe('Bearer k')
    expect(ctx.channels.getDriver('onebot11')?.label).toContain('正向')
    await fiber.dispose()
  })
})

/**
 * 破损类：**插件仍是插件，但装载器看不见它的声明**。
 *
 * 实测 cordis-plugin-loader：`exports = exports.default ?? exports` —— 模块一旦
 * 有 default 导出，inject / Config / apply 这些具名导出会被整体丢弃，
 * 用户看到的是「装上了但从不激活、设置页里也没有字段」。
 */
function unwrapExports(exports: unknown): Record<string, unknown> {
  let value = exports as Record<string, unknown> | null | undefined
  if (value === null || value === undefined) return {}
  value = (value.default as Record<string, unknown> | undefined) ?? value
  return value as Record<string, unknown>
}

describe('插件入口在装载器眼里必须完好', () => {
  it('具名导出齐全：inject、apply 与 Config 都在，且没有被 default 顶掉', () => {
    const plugin = unwrapExports(driver)

    expect(plugin.inject).toEqual(['channels'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.name).toBe('driver-onebot11')
    // Config 是要给 host 读字段的 schema，丢了它设置页就是空的。
    expect((plugin.Config as { '~standard'?: unknown } | undefined)?.['~standard']).toBeDefined()
  })
})
