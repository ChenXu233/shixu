import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { ReverseWs } from '../dist/transport.js'

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
