/**
 * OneBot 11 驱动插件。
 *
 * 一行挂载 = 一个账号。连接方向由 config.mode 决定：反向由机器人连我们，
 * 正向由我们连对方的 WS 服务端。协议语义在 protocol.ts，传输在 transport.ts；
 * 这里只做装配：把两者接到渠道内核上。
 *
 * 门 A 的动作目录在 protocol.ts 的 ACTIONS 里；门 B（没词表的能力）现在没有 ——
 * 需要时由这个包自带一个 MCP server，内核不需要知道（见 ADR-0006）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Channels } from 'dsh-shixu-channel'
import type { ChannelDriver, ChatSession, MessageSegment, UnifiedEvent } from 'dsh-shixu-channel/contracts'
import { Config, type DriverConfig } from './config.js'
import { ACTIONS, ACTION_API, CAPABILITIES, normalize, toOneBotMessage, type RawEvent } from './protocol.js'
import { ForwardWs, ReverseWs, type Transport } from './transport.js'

/** 配置 schema 要给装载器看见，否则 host 不知道这一行有哪些字段。 */
export { Config }

/** Cordis 插件名。 */
export const name = 'driver-onebot11'

/** 只依赖渠道内核。 */
export const inject = ['channels']

/** 正向缺地址时的报错。要能说出缺的是 url，否则使用者不知道去填哪一格。 */
const MISSING_URL = 'onebot11: 正向模式缺少 url —— 请填对方的 WS 服务端地址（例如 ws://127.0.0.1:3001）'

export function apply(ctx: Context, config: DriverConfig): void {
  // `ctx.channels` 的类型由 dsh-shixu-channel 对 cordis 的模块扩充提供；
  // 这里显式拿一次，免得扩充没被加载时静默退化成 any。
  const channels: Channels = ctx.channels
  const platform = config.platform
  const mode = config.mode.get()
  const log = ctx.logger('driver-onebot11')

  // 传输先建：缺 url 这类配置错误要在注册 driver 之前炸，别留下半个驱动。
  const transport = mode === 'forward' ? forwardTransport(config) : reverseTransport(config)
  const label = mode === 'forward' ? 'OneBot 11（正向 WebSocket）' : 'OneBot 11（反向 WebSocket）'

  let handler: ((event: UnifiedEvent) => void) | undefined

  const driver: ChannelDriver = {
    protocol: 'onebot11',
    label,
    actions: ACTIONS,
    capabilities: CAPABILITIES,

    onEvent(next) {
      handler = next
    },

    async call(action, params) {
      // 'send' 是内核的出站路径（人格的回复），不经过动作目录，模型也调不到。
      if (action === 'send') {
        const { session, segments } = params as { session: ChatSession; segments: MessageSegment[] }
        const message = toOneBotMessage(segments)
        const isGroup = session.conversationType !== 'private'
        const data = await transport.call(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
          ? { group_id: Number(session.venue.conversationId), message }
          : { user_id: Number(session.venue.conversationId), message })
        const messageId = (data as { message_id?: unknown } | undefined)?.message_id
        return { ...(messageId === undefined ? {} : { messageId: String(messageId) }), degradations: [] }
      }

      const binding = ACTION_API[action]
      if (binding === undefined) throw new Error(`onebot11: 不认识的动作 "${action}"`)
      return await transport.call(binding.api, binding.build((params ?? {}) as Record<string, unknown>))
    },
  }

  transport.onEvent((payload) => {
    const event = normalize(payload as RawEvent, platform)
    if (event === undefined) return
    handler?.(event)
  })

  ctx.effect(() => {
    void transport.start().then(
      () => {
        if (transport instanceof ReverseWs) {
          log.info('%s 已监听 %s:%d', label, config.host.get(), transport.port)
          return
        }
        log.info('%s 已启动（%s）', label, transport.connected ? '已连上对方' : '等待重连')
      },
      (error: unknown) => log.error('%s 启动失败：%s', label, String(error)),
    )
    return () => void transport.stop()
  }, 'driver-onebot11.transport')

  channels.registerDriver(driver)
}

/** 正向：我们去连对方。缺地址就直接报错，别让插件装上一个永远连不出去的传输。 */
function forwardTransport(config: DriverConfig): Transport {
  const url = config.url.get()
  if (url === undefined || url.trim() === '') throw new Error(MISSING_URL)

  const accessToken = config.accessToken.get()
  return new ForwardWs({
    url,
    ...(accessToken === undefined || accessToken === '' ? {} : { accessToken }),
  })
}

/** 反向：我们监听。url 在这个方向上是无关字段，读都不读。 */
function reverseTransport(config: DriverConfig): Transport {
  const accessToken = config.accessToken.get()
  return new ReverseWs({
    port: config.port.get(),
    host: config.host.get(),
    ...(accessToken === undefined || accessToken === '' ? {} : { accessToken }),
  })
}
