# 路线图

> **状态**：生效中（唯一一份进度表）
> **日期**：2026-10-31
> **读者**：要判断「现在做到哪了 / 下一步做什么」的人
> **上游材料**：[决策登记](adr/README.md)、[分层与 bundle 形态](reference/layering.md)
> **口径**：阶段与完成判据；每一项的状态只在「状态」列改，不另建第二份进度表

## 现状

**P1 已完成，P2 已开工，P0 收尾中。** 真机链路已经跑通：QQ 群 @ → 反向 WebSocket → 人格 agent → 回复回到群里；动作目录里的只读与可逆动作自动变成工具，模型真实调用过（`qq_member_list`）；入站图片落成附件后进模型视野，模型能描述图里的内容。

P2 已落地：人格工作区（cwd = 人格目录、侧栏名 `时煦-<personaId>`）、场所会话复用、人设三段（我是谁 / 什么时候说话 / 怎么说话）、身份与权限（信任表 + 角色矩阵 + 工具闸门）、出站节奏（打字停顿、按句拆分、引用档位），以及 `history` / `search` / `reply_to` / `send` 四件工具。还缺记忆分层、控制台面板、凭据落位。

P3 已落骨架：场所感知缓冲与接话判定（规则打分，跑影子模式，只记日志不开口）。还缺预算（并发、限速、阻尼）与开闸。

P0 只剩「`dsh-im` 与 `dsh-im-gateway` 两套现有实现能映射进来」这一条判据未验。

| 阶段 | 交付物 | 完成判据 | 状态 | 相关文档 |
|---|---|---|---|---|
| **P0 契约** | 统一事件模型 · Capabilities · MessageSegment · ActionDescriptor · ChannelProfile · 账号与场所键 · 身份与权限契约 · 风险判据 | 一份可评审的规范 + TS 类型包；`dsh-im` 与 `dsh-im-gateway` 两套现有实现能映射进来 | 进行中 | [渠道内核契约](reference/contracts-channel.md) · [人格引擎契约](reference/contracts-persona.md) · [判据](reference/policies.md) · [DSH 接缝](reference/dsh-seams.md) |
| **P1 单协议跑通** | `dsh-shixu-channel` + `dsh-shixu-driver-onebot11`（反向 WS）+ 一个 read / write 动作 | 群 @ → Agent → 回复全链路；动作目录自动生成工具并被模型真实调用一次 | 已完成 | [渠道内核契约](reference/contracts-channel.md) · [渠道内核：为什么](explanation/channel-core.md) |
| **P2 人格层** | 人格工作区（git）+ 场所 session / child agent + 控制台 GUI + 记忆分层 + 凭据落位 + capability 校验 | 多群共用一个人格；控制台能看到真实回复；记忆按层可见；guest 调不动工具 | 进行中 | [人格与场所](explanation/persona-presence.md) · [跨场所记忆](explanation/memory.md) · [权限与身份](explanation/permission-identity.md) |
| **P3 注意力与自主** | 在场集合 + 预算 + 阻尼 + 公平插队 + 离场记忆 + 原生 goal 续轮 + schedule + 记忆版本化与做梦 | 能在多群之间自然切换而不刷屏；不赖着不走；会主动开口；记忆有历史可回滚可分叉 | 进行中 | [人格与场所](explanation/persona-presence.md) · [沙箱与产物交付](explanation/sandbox-delivery.md) · [跨场所记忆](explanation/memory.md) |
| **P4 扩张与迁移** | OneBot 12 / Satori / Milky / 原生 Telegram · Discord · 飞书 + 自我复制（mesh 跨机） | 多协议多平台；人格可迁到新机器且记忆连续、身份可验 | 未开始 | [生态](explanation/ecosystem.md) · [复制与迁移](explanation/replication.md) |

## 每阶段协议

| 阶段 | 协议 | 理由 |
|---|---|---|
| P1 | OneBot 11（反向 WS 优先） | 覆盖最广：NapCat / LLOneBot / Lagrange v1 / SnowLuma 现成可用 |
| P2 | OneBot 12 | 账号语义 + 事件 id 去重，正好是生态空白 |
| P3 | Satori / Milky | 面向 Lagrange v2 之后的供给迁移 |
| 并行 | 原生 API：Telegram / Discord / 飞书 | 动作目录最丰富（Discord 的 reaction / role / thread） |

供给风险的判断见[生态与协议路线](explanation/ecosystem.md)。

## P1 最小切片

onebot11 driver（反向 WS）+ 一个 read / write 动作 + 群聊 @ 触发 + 一条渠道提示词。跑通即证明「驱动声明动作 → 自动变工具 → AI 调用 → 回执回到会话」这条路成立。

## 依赖

P4 的跨机部分依赖 `dsh-workspace-mesh` 走完其 P2（TypertTransport，门控于 S0 spike）与其 bus 平面 spike 评审通过。
