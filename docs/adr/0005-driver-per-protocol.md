# ADR-0005：驱动按协议切，平台是数据

> **状态**：`accepted`
> **日期**：2026-11-01
> **落地阶段**：P0
> **上游材料**：[渠道内核契约](../reference/contracts-channel.md)、[分层与 bundle 形态](../reference/layering.md)

## 背景

同一个平台往往有好几条协议路。QQ 至少三条：腾讯官方机器人 API、OneBot 11（NapCat / Lagrange / LLOneBot 各自实现）、Satori。反过来，一种协议也能同时承载多个平台 —— Satori 一套接口就能接 QQ、Telegram、Discord。

契约最初的写法把这两件事混在一个字段里：

- `ChannelDriver.id` 的示例值是 `'discord' | 'onebot11' | 'telegram'` —— 前两个是平台，第三个是协议；
- 出站按 `platform` 查驱动表；
- 但 `Account.protocol` 早就作为独立字段存在。

两个后果都能预演：同一个 QQ 装两条协议，注册表键直接相撞；一个 Satori 驱动服务三个平台，查表查不到它。

## 决策

**一个 driver = 一种线缆协议。`platform` 是账号的身份字段，不是路由键。**

三处固定下来：

| 位置 | 事实 |
|---|---|
| 注册表键 | `ChannelDriver.protocol` |
| 事件 | 内核扇出时盖上 `protocol` —— 驱动填不了，也骗不了 |
| 会话 | `ChatSession.protocol` 决定出站走哪条线缆 |

**判据：换平台只改数据，换协议才换代码。** 把 QQ 从 NapCat 换成 Lagrange，动的应该是 `Account` 里的 `platform` / `accountId` / 凭据；把 QQ 从 OneBot 11 换到官方机器人 API，才该换一个包。

## 被否决的替代

| 替代 | 否决理由 |
|---|---|
| 按平台切 | 并装即撞：一个 QQ 装两条协议就没有可用的注册表键 |
| 按「平台 × 协议」组合切 | M×N 个包，而差异几乎全在协议那一侧；组合本身不携带任何新语义 |
| 把协议做成驱动的配置项 | 注册表键仍然必须唯一，配置项救不了并装 |

## 影响

- 加一种协议 = 新包 + `cordis.patch.yml` 一行 + profile 一行，`packages/channel/src` 的 diff 应为 0。这条是「兼容」唯一有意义的定义。
- 同一种协议的不同实现之间也有差异（NapCat 与 Lagrange 的字段、错误码、限速），那是 `variant`，不是新包；只有**动作集**真的不同才拆包，走 [ADR-0004](0004-grow-by-friction.md) 的摩擦触发。
- 场所身份不变：`(platform, accountId, conversationId, threadId)` 仍然是「哪个人在哪说话」。

## 指针

- 字段定义：[渠道内核契约](../reference/contracts-channel.md#actiondescriptor-与-channeldriver)
- 包名规则：[分层与 bundle 形态](../reference/layering.md#包名规则唯一一处)
