import { Service, type Context } from '@deepseek-ai/cordis'
import type { Account, ChannelDriver, ChatSession, MessageSegment, UnifiedEvent } from './contracts.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 渠道内核：驱动注册表、账号表、事件扇出、出站路由。 */
    channels: Channels
  }

  interface Events {
    /** 任一 driver 产出的统一事件。消费方 inject 'channels' 之后监听它。 */
    'channels/event'(event: UnifiedEvent): void
  }
}

/** 注册成功时返回的撤销函数；插件卸载时自动调用。 */
export type Unregister = () => void

/**
 * 渠道内核。
 *
 * 它只做四件事：记住有哪些 driver、记住有哪些账号、把入站事件扇出成
 * `channels/event`、把出站消息按会话路由回对应 driver。
 * 它不认识任何具体平台，也不生成工具 —— 那是后面按摩擦长出来的事。
 */
export class Channels extends Service {
  private readonly drivers = new Map<string, ChannelDriver>()
  private readonly accountTable = new Map<string, Account>()

  constructor(ctx: Context) {
    super(ctx, 'channels')
  }

  /**
   * 注册一个 driver。注册即以当前插件的生命周期为界：driver 插件卸载，
   * 它自动从表里消失，不需要谁来手动清理。
   */
  registerDriver(driver: ChannelDriver): Unregister {
    return this.ctx.effect(() => {
      if (this.drivers.has(driver.id)) {
        throw new Error(`channels: driver "${driver.id}" 已经注册过`)
      }
      this.drivers.set(driver.id, driver)
      driver.onEvent((event) => {
        // 驱动卸载后，socket 可能还会送来最后几条消息（晚到事件）——
        // 已经不在表里的 driver 不许再把事件扇出去，否则热重载会出现幽灵消息。
        if (this.drivers.get(driver.id) !== driver) return
        this.ctx.events.emit('channels/event', event)
      })
      return () => {
        this.drivers.delete(driver.id)
      }
    }, `channels.registerDriver(${driver.id})`)
  }

  getDriver(id: string): ChannelDriver | undefined {
    return this.drivers.get(id)
  }

  /** 已挂载的 driver，按平台 id 排序，便于日志与诊断。 */
  listDrivers(): ChannelDriver[] {
    return [...this.drivers.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  registerAccount(account: Account): Unregister {
    return this.ctx.effect(() => {
      if (this.accountTable.has(account.id)) {
        throw new Error(`channels: account "${account.id}" 已经注册过`)
      }
      this.accountTable.set(account.id, account)
      return () => {
        this.accountTable.delete(account.id)
      }
    }, `channels.registerAccount(${account.id})`)
  }

  accounts(): Account[] {
    return [...this.accountTable.values()]
  }

  /**
   * 把一条出站消息路由到会话所属平台的 driver。
   * 没有对应 driver 时抛错而不是静默丢弃 —— 丢消息比报错更难查。
   */
  async send(session: ChatSession, segments: MessageSegment[]): Promise<unknown> {
    const driver = this.drivers.get(session.platform)
    if (driver === undefined) {
      throw new Error(`channels: 没有处理 "${session.platform}" 的 driver（会话 ${session.key}）`)
    }
    return driver.call('send', { session, segments })
  }
}

export default Channels