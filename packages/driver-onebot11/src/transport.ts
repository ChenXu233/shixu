/**
 * 反向 WebSocket 传输：机器人连我们，事件从这条连接上来，API 调用从同一条下去。
 *
 * 这一层只做三件事：鉴权、收事件、按 echo 把调用和响应配起来。
 * 协议语义在 protocol.ts，插件装配在 index.ts。
 */
import { WebSocketServer, WebSocket } from 'ws'

export interface ReverseWsOptions {
  host?: string
  port: number
  /** 反向 WS 的路径；机器人那边要配成一样。 */
  path?: string
  /** 留空表示不校验；生产必须填。 */
  accessToken?: string
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ReverseWs {
  private server: WebSocketServer | undefined
  private socket: WebSocket | undefined
  private readonly pending = new Map<string, Pending>()
  private handler: ((event: unknown) => void) | undefined
  private sequence = 0

  constructor(private readonly options: ReverseWsOptions) {}

  onEvent(handler: (event: unknown) => void): void {
    this.handler = handler
  }

  /** 实际监听的端口。传 0 时由系统分配，所以调用方要知道真的落在哪。 */
  get port(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address !== null ? address.port : this.options.port
  }

  get connected(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN
  }

  async start(): Promise<void> {
    const server = new WebSocketServer({
      host: this.options.host ?? '127.0.0.1',
      port: this.options.port,
      path: this.options.path ?? '/',
    })
    this.server = server
    server.on('connection', (socket, request) => this.accept(socket, request.headers.authorization))
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve())
      server.once('error', reject)
    })
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('onebot11: 连接已关闭'))
    }
    this.pending.clear()
    this.socket?.close()
    this.socket = undefined
    const server = this.server
    this.server = undefined
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** 发一个 API 调用，按 echo 等回包。 */
  call(action: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('onebot11: 机器人还没连上来，发不出去'))
    }

    const echo = `${Date.now()}-${++this.sequence}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`onebot11: ${action} 超时（${timeoutMs} ms）`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      socket.send(JSON.stringify({ action, params, echo }))
    })
  }

  private accept(socket: WebSocket, authorization: string | undefined): void {
    const expected = this.options.accessToken
    if (expected !== undefined && expected !== '' && authorization !== `Bearer ${expected}`) {
      // 1008 = policy violation。不认的连接直接关，不给它发任何东西。
      socket.close(1008, 'unauthorized')
      return
    }

    // 一个账号一条连接：新的顶掉旧的，避免两路同时发消息。
    this.socket?.close()
    this.socket = socket
    socket.on('message', (data) => this.receive(String(data)))
  }

  private receive(text: string): void {
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return
    }
    if (payload === null || typeof payload !== 'object') return

    const record = payload as Record<string, unknown>
    const echo = record.echo
    if (typeof echo === 'string') {
      const pending = this.pending.get(echo)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(echo)
      if (record.status === 'ok' || record.status === 'async') pending.resolve(record.data)
      else pending.reject(new Error(`onebot11: ${String(record.status)} retcode=${String(record.retcode ?? '')}`))
      return
    }

    this.handler?.(payload)
  }
}
