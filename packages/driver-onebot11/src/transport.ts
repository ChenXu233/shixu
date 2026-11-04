/**
 * 两种连接方向的线缆，共用一套收发。
 *
 * - 反向（ReverseWs）：机器人连我们，我们监听端口。
 * - 正向（ForwardWs）：我们连对方的 WS 服务端，穿得出去只允许出站的网络。
 *
 * 这一层只做三件事：鉴权、收事件、按 echo 把调用和响应配起来。
 * 协议语义在 protocol.ts，插件装配在 index.ts。
 */
import { WebSocketServer, WebSocket } from 'ws'

/**
 * 两种方向对上层是同一件事：启动、停掉、收事件、发调用。
 * index.ts 只按配置挑一个，别的一概不关心。
 */
export interface Transport {
  /** 注册入站回调；报文已经解析成对象，认不出的形状交给调用方判断。 */
  onEvent(handler: (event: unknown) => void): void
  start(): Promise<void>
  stop(): Promise<void>
  /** 发一个 API 调用，按 echo 等回包。 */
  call(action: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
  /** 现在是不是有一条能收发的连接。 */
  readonly connected: boolean
}

export interface ReverseWsOptions {
  host?: string
  port: number
  /** 反向 WS 的路径；机器人那边要配成一样。 */
  path?: string
  /** 留空表示不校验；生产必须填。 */
  accessToken?: string
  /**
   * 已经有一条活着的连接时，新的连接要不要顶掉它。默认不顶（`false`）：
   * 一个账号只有一条连接，误连的客户端不该把正在用的那条踢掉。
   */
  takeover?: boolean
  /** 多久没收到对方任何报文就当它已经死了。默认 90 秒：OneBot 心跳默认 30 秒，留三次余量。 */
  peerStaleMs?: number
}

export interface ForwardWsOptions {
  /** 对方的 WS 服务端地址，例如 ws://127.0.0.1:3001/。 */
  url: string
  /** 与对方一致的访问令牌；连接时以 Authorization: Bearer 带上。 */
  accessToken?: string
  /** 断开后重连的固定间隔（毫秒）。默认 1000：拨得太密，对方会当成扫描。 */
  reconnectMs?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 两种方向唯一不一样的是「谁连谁」和「断了怎么办」；其余全在这里：
 * 认 socket、收报文、按 echo 配对回包。
 */
abstract class SocketTransport implements Transport {
  protected socket: WebSocket | undefined
  private readonly pending = new Map<string, Pending>()
  private handler: ((event: unknown) => void) | undefined
  private sequence = 0
  /** 最近一次收到对端报文的时间，用来判断「这条连接还算活着吗」。 */
  private lastSeen = 0

  /** 默认 90 秒：OneBot 心跳默认 30 秒，留三次余量。 */
  protected staleMs = 90_000

  onEvent(handler: (event: unknown) => void): void {
    this.handler = handler
  }

  get connected(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN
  }

  abstract start(): Promise<void>
  abstract stop(): Promise<void>

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

  /**
   * 现在这条连接还算活着吗 —— 开着、并且最近确实收到过东西。
   *
   * 只看 `readyState` 不够：对端进程卡死或网线拔掉时，socket 会一直显示 OPEN，
   * 要等内核超时才变成 CLOSED。那段时间里它发不出也收不到。
   */
  protected peerAlive(): boolean {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
    return Date.now() - this.lastSeen < this.staleMs
  }

  /** 认下一条能收发的 socket。 */
  protected adopt(socket: WebSocket): void {
    const previous = this.socket
    this.socket = socket
    this.lastSeen = Date.now()
    socket.on('message', (data) => {
      this.lastSeen = Date.now()
      this.receive(String(data))
    })
    if (previous !== undefined && previous !== socket) previous.close()
  }

  /**
   * 放掉当前 socket，并把还等着的调用立刻判失败。
   * 让调用方等满 30 秒超时才报错，比当场说「连接断了」难查得多。
   */
  protected release(reason: string): void {
    const socket = this.socket
    this.socket = undefined
    socket?.close()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
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

export class ReverseWs extends SocketTransport {
  private server: WebSocketServer | undefined
  private readonly options: ReverseWsOptions

  constructor(options: ReverseWsOptions) {
    super()
    this.options = options
  }

  /** 实际监听的端口。传 0 时由系统分配，所以调用方要知道真的落在哪。 */
  get port(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address !== null ? address.port : this.options.port
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
    this.release('onebot11: 连接已关闭')
    const server = this.server
    this.server = undefined
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private accept(socket: WebSocket, authorization: string | undefined): void {
    const expected = this.options.accessToken
    if (expected !== undefined && expected !== '' && authorization !== `Bearer ${expected}`) {
      // 1008 = policy violation。不认的连接直接关，不给它发任何东西。
      socket.close(1008, 'unauthorized')
      return
    }

    this.staleMs = this.options.peerStaleMs ?? 90_000
    if (this.options.takeover !== true && this.peerAlive()) {
      // 已经有一条活着的连接：新来的这条不接。一个账号只有一条连接，
      // 误连的客户端不该把正在回消息的那条挤掉。
      socket.close(1008, 'another client is already connected')
      return
    }

    this.adopt(socket)
  }
}

/**
 * 正向 WebSocket：我们主动连对方。
 *
 * 断线不是异常而是常态（对方重启、网络抖动），所以断开后按固定间隔重连；
 * 但 stop() 之后一次也不许再拨 —— 那是插件卸载，不是一次抖动。
 */
export class ForwardWs extends SocketTransport {
  private readonly options: ForwardWsOptions
  private timer: ReturnType<typeof setTimeout> | undefined
  private dialing: WebSocket | undefined
  private stopped = true

  constructor(options: ForwardWsOptions) {
    super()
    this.options = options
  }

  /**
   * 连第一次。首连失败**不抛**：NapCat 可能比我们晚几秒才就绪，
   * 插件不该因为对方还没起就装不上。返回时只表示这次尝试有了结论，
   * 到底连没连上由 connected 说。
   */
  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    await this.dial()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // 还在拨的那一条也要掐掉，否则它连上之后会留下一条没人认领的连接。
    this.dialing?.close()
    this.dialing = undefined
    this.release('onebot11: 连接已关闭')
  }

  private dial(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stopped) {
        resolve()
        return
      }

      const token = this.options.accessToken
      const socket = new WebSocket(this.options.url, {
        ...(token === undefined || token === '' ? {} : { headers: { authorization: `Bearer ${token}` } }),
      })
      this.dialing = socket

      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }

      socket.once('open', () => {
        this.dialing = undefined
        this.adopt(socket)
        settle()
      })

      socket.once('error', () => {
        // 连不上时 ws 会先 error 再 close；这里只让 start() 别等着，重连统一看 close。
        if (this.dialing === socket) this.dialing = undefined
        this.scheduleReconnect()
        settle()
      })

      socket.once('close', () => {
        if (this.dialing === socket) this.dialing = undefined
        if (this.socket === socket) this.release('onebot11: 连接已断开，正在重连')
        // 只有「从来没连上」或「当前那条刚断」才重拨：被新连接顶掉的旧 socket
        // 关掉时若也重拨，会多拨出一条没人要的连接。
        if (this.socket === undefined) this.scheduleReconnect()
        settle()
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer !== undefined) return
    const timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopped) return
      void this.dial()
    }, this.options.reconnectMs ?? 1000)
    // 单测和 CLI 里没人管的后台定时器不该把进程钉住。
    timer.unref?.()
    this.timer = timer
  }
}
