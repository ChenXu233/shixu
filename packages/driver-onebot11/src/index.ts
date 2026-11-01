/**
 * OneBot 11 驱动插件。
 *
 * 一行挂载 = 一个反向 WebSocket 监听 = 一个账号。协议语义在 protocol.ts，
 * 传输在 transport.ts；这里只做装配：把两者接到渠道内核上。
 *
 * 门 A 的动作目录在 protocol.ts 的 ACTIONS 里；门 B（没词表的能力）现在没有 ——
 * 需要时由这个包自带一个 MCP server，内核不需要知道（见 ADR-0006）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Channels } from 'dsh-shixu-channel'
import type { ChannelDriver, ChatSession, MessageSegment, UnifiedEvent } from 'dsh-shixu-channel/contracts'
import { ACTIONS, ACTION_API, CAPABILITIES, normalize, toOneBotMessage, type RawEvent } from './protocol.js'
import { ReverseWs } from './transport.js'

/** Cordis 插件名。 */
export const name = 'driver-onebot11'

/** 只依赖渠道内核。 */
export const inject = ['channels']

export interface Config {
  /** 平台名，进 SelfRef。同一个 QQ 用 OneBot 11 接就是 qq。 */
  platform?: string
  /** 反向 WS 监听地址。默认只听本机 —— 要对外开放得显式写。 */
  host?: string
  /** 反向 WS 监听端口。机器人那边填同一个。 */
  port: number
  /** 反向 WS 路径。 */
  path?: string
  /** 访问令牌。应与机器人那边配置一致；留空表示不校验。 */
  accessToken?: string
}

export function apply(ctx: Context, config: Config): void {
  // `ctx.channels` 的类型由 dsh-shixu-channel 对 cordis 的模块扩充提供；
  // 这里显式拿一次，免得扩充没被加载时静默退化成 any。
  const channels: Channels = ctx.channels
  const platform = config.platform ?? 'qq'
  const log = ctx.logger('driver-onebot11')
  const transport = new ReverseWs({
    port: config.port,
    ...(config.host === undefined ? {} : { host: config.host }),
    ...(config.path === undefined ? {} : { path: config.path }),
    ...(config.accessToken === undefined ? {} : { accessToken: config.accessToken }),
  })

  let handler: ((event: UnifiedEvent) => void) | undefined

  const driver: ChannelDriver = {
    protocol: 'onebot11',
    label: 'OneBot 11（反向 WebSocket）',
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
        const isGroup = session.conversationType === 'group' || session.conversationType === 'guild'
        const data = await transport.call(isGroup ? 'send_group_msg' : 'send_private_msg', isGroup
          ? { group_id: Number(session.conversationId), message }
          : { user_id: Number(session.conversationId), message })
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
      () => log.info('反向 WS 已监听 %s:%d', config.host ?? '127.0.0.1', transport.port),
      (error: unknown) => log.error('反向 WS 启动失败：%s', String(error)),
    )
    return () => void transport.stop()
  }, 'driver-onebot11.reverse-ws')

  channels.registerDriver(driver)
}
