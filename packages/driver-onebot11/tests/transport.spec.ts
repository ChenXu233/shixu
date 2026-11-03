import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type AddressInfo } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { ForwardWs, ReverseWs } from '../lib/transport.js'

/**
 * 传输层只有两件事会出事：不认识的人连进来，以及两个调用的回包串了。
 * 这两件都能用一条真实的本地连接验证，不需要假对象。
 */

let server: ReverseWs | undefined
let client: WebSocket | undefined

afterEach(async () => {
  client?.close()
  client = undefined
  await server?.stop()
  server = undefined
})

async function connect(token: string | undefined): Promise<WebSocket> {
  server = new ReverseWs({ host: '127.0.0.1', port: 0, accessToken: 'k' })
  await server.start()
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, {
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  })
  client = socket
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  return socket
}

describe('反向 WebSocket', () => {
  it('事件能上来，API 调用按 echo 拿到回包', async () => {
    const socket = await connect('k')
    const events: unknown[] = []
    server!.onEvent((event) => events.push(event))

    const reply = server!.call('send_group_msg', { group_id: 222 })
    socket.once('message', (data) => {
      const request = JSON.parse(String(data)) as { action: string; echo: string }
      expect(request.action).toBe('send_group_msg')
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: request.echo }))
    })
    expect(await reply).toEqual({ message_id: 42 })

    socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 222, user_id: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toHaveLength(1)
  })

  it('令牌不对的连接进不来，也就发不出任何东西', async () => {
    server = new ReverseWs({ host: '127.0.0.1', port: 0, accessToken: 'k' })
    await server.start()
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers: { authorization: 'Bearer wrong' } })
    client = socket
    const code = await new Promise<number>((resolve) => socket.once('close', (value) => resolve(value)))
    expect(code).toBe(1008)
    expect(server.connected).toBe(false)
  })
})

/**
 * 破损类：**网络只允许出站的环境里，机器人连不上我们，一条消息也收不到**。
 *
 * 正向传输就是为这种环境准备的：我们主动连对方的 WS 服务端。所以这里验的
 * 是三件用户看得见的事：连得上、断了会自己接上、以及停掉之后不再偷偷连。
 */

interface Peer {
  url: string
  connections: { socket: WebSocket; headers: IncomingHttpHeaders }[]
}

let peer: WebSocketServer | undefined
let forward: ForwardWs | undefined

/** 起一个本地 WS 服务冒充对方（NapCat 的正向 WS 服务端）。传端口时用预先挑好的那个。 */
async function startPeer(port = 0): Promise<Peer> {
  const wsServer = new WebSocketServer({ host: '127.0.0.1', port })
  await new Promise<void>((resolve) => wsServer.once('listening', () => resolve()))
  const connections: { socket: WebSocket; headers: IncomingHttpHeaders }[] = []
  wsServer.on('connection', (socket, request) => connections.push({ socket, headers: request.headers }))
  peer = wsServer
  const { port: listening } = wsServer.address() as AddressInfo
  return { url: `ws://127.0.0.1:${listening}`, connections }
}

/** 找一个当前没人监听的端口，用来演「对方还没起来」。 */
async function reservePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** 等某个条件成立；超时就抛，免得测试挂到 vitest 的默认超时上。 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs} ms）`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  await forward?.stop()
  forward = undefined
  peer?.clients.forEach((socket) => socket.terminate())
  const closing = peer
  peer = undefined
  if (closing !== undefined) await new Promise<void>((resolve) => closing.close(() => resolve()))
})

describe('正向 WebSocket', () => {
  it('连上之后事件能上来，API 调用也按 echo 拿到回包', async () => {
    const { url, connections } = await startPeer()
    forward = new ForwardWs({ url })
    const events: Record<string, unknown>[] = []
    forward.onEvent((event) => events.push(event as Record<string, unknown>))

    await forward.start()
    await waitFor(() => connections.length === 1)
    expect(forward.connected).toBe(true)

    const socket = connections[0]!.socket
    socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 222 }))
    await waitFor(() => events.length === 1)
    expect(events[0]?.group_id).toBe(222)

    const reply = forward.call('send_group_msg', { group_id: 222 })
    socket.once('message', (data) => {
      const request = JSON.parse(String(data)) as { action: string; echo: string }
      expect(request.action).toBe('send_group_msg')
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7 }, echo: request.echo }))
    })
    expect(await reply).toEqual({ message_id: 7 })
  })

  it('连对方时带上 Bearer 令牌', async () => {
    const { url, connections } = await startPeer()
    forward = new ForwardWs({ url, accessToken: 'k' })

    await forward.start()
    await waitFor(() => connections.length === 1)
    expect(connections[0]!.headers.authorization).toBe('Bearer k')
  })

  it('对方断开后自己接上，且不是立刻空转（间隔 ≥ 1s）', async () => {
    const { url, connections } = await startPeer()
    forward = new ForwardWs({ url })

    await forward.start()
    await waitFor(() => connections.length === 1)

    const closedAt = Date.now()
    connections[0]!.socket.close()
    await waitFor(() => connections.length === 2, 4000)
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(900)
    // 服务端的 connection 先到、客户端的 open 后到：等它把状态翻过来再断言，
    // 差的这几十毫秒在慢的机器上会被放大成一条假红。
    await waitFor(() => forward.connected)
  })

  it('stop() 之后不再重连', async () => {
    const { url, connections } = await startPeer()
    forward = new ForwardWs({ url, reconnectMs: 50 })

    await forward.start()
    await waitFor(() => connections.length === 1)

    // 先断开，再立刻停：重连定时器必须被这次 stop 取消，而不是照点再拨一次。
    connections[0]!.socket.close()
    await forward.stop()
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(connections).toHaveLength(1)
    expect(forward.connected).toBe(false)
  })

  it('对方还没起来时不抛错，起来之后自己连上', async () => {
    const port = await reservePort()
    forward = new ForwardWs({ url: `ws://127.0.0.1:${port}`, reconnectMs: 50 })

    // 首连失败不能让插件起不来：NapCat 可能比我们晚几秒才就绪。
    await forward.start()
    expect(forward.connected).toBe(false)

    const late = await startPeer(port)
    await waitFor(() => late.connections.length === 1, 3000)
    expect(forward.connected).toBe(true)
  })
})
