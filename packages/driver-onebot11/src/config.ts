/**
 * 驱动的配置 schema。
 *
 * 声明在这是给 host 看的：设置页据此知道有哪些字段、怎么校验。
 * `.volatile()` 的字段按引用读（改了不用重启整个插件），
 * `accessToken` 标了 secret，回读时由 host 打码。
 *
 * 字段落盘位置仍是 profile patch 里那一行的 config，这里只是它的形状。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  // 平台名，进 SelfRef。同一个 QQ 用 OneBot 11 接就是 qq。
  platform: z.string().default('qq'),
  // 连接方向：reverse = 机器人连我们；forward = 我们连对方。老配置没这个字段时按反向走。
  mode: z.union([z.const('reverse'), z.const('forward')]).default('reverse').volatile(),
  // 正向时的对方地址，例如 ws://127.0.0.1:3001/。反向不读这个字段。
  url: z.string().volatile(),
  // 反向 WS 监听地址。默认只听本机 —— 要对外开放得显式写。
  host: z.string().default('0.0.0.0').volatile(),
  // 反向 WS 监听端口；机器人那边填同一个。
  port: z.natural().default(6700).volatile(),
  // 访问令牌，应与机器人那边一致；留空表示不校验。
  accessToken: z.string().role('secret').volatile(),
})

/** apply 拿到的类型：校验过、默认值填好、volatile 字段是可读引用。 */
export type DriverConfig = ReturnType<typeof Config>
