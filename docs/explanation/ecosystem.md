# 协议路线与生态定位

> **状态**：已决议（生态数字是快照，见外部依据）
> **日期**：2026-10-31
> **读者**：决定「先接哪个协议」「要不要出线缆协议」的人
> **上游材料**：[外部依据与快照口径](../reference/sources.md)、[路线图](../roadmap.md)
> **口径**：定性判断长期有效；引用的数字必须带回口径名称与测量日期

## 三条关键事实

1. **LagrangeV2 已放弃 OneBot 11**（官方文档原文：不再支持 OB11，V1 的 OB11 实现也不再维护），改推 Milky 协议 + NativeAPI；Satori（satori.chat）也是新的跨平台协议 → 只押 OB11 的供给正在收缩。
2. **OneBot 12 的 `self{platform, user_id}` + 多账号共享连接 + 事件必有唯一 id**，是账号模型与去重该抄的那一版。而全 DSH 生态**没有任何插件支持 OB12**（空白）。
3. 已有插件是事实标准：`dsh-im`（11 渠道）、`dsh-qqbot`（腾讯官方）、`dsh-wechat`、`dsh-onebot`、`dsh-qq-bridge`（NapCat OneBot11）、`dsh-im-gateway`（唯一有显式 `ChannelAdapter` 接口，但停更、无人复用）。

结论：**内核必须平台无关，协议只是 driver。** 每阶段选哪个协议见[路线图](../roadmap.md#每阶段协议)。

若走线缆协议（让 Go / Python driver 直接接），事件帧必须自带完整身份（accountId / chatId / threadId / messageId），因为 initiator scope 是进程内的，跨进程不自动携带。

## 线缆协议：DSH 已有 Typert

Typert 子系统已提供远程方法调用：lookup / Context 声明、`InvocationDescriptor`、严格 codec、SRC codec、stream 模式、取消信号，以及生成 `./typert`、`./remote`、`./client/typert` 三件套的生成器。

含义：driver 可以做成**远程方法**暴露给 DSH（跨进程、跨语言），不必是进程内 TS 插件。但生成式开发门槛不低 → **P1–P2 走进程内 TS driver，P3 再评估**。

## 开源现状对照

组件都有先例，这一整套没人做过。

| 项目 | 已经做到哪一步 | 与本设计的差距 |
|---|---|---|
| OpenClaw（MIT；Tencent/openclaw-weixin 是其微信 channel 插件） | Gateway + channel 插件 + **pairing 配对** + session 隔离（per-account-channel-peer）+ 插件市场 | 最接近「多渠道个人助理 + 身份绑定」；但没有「动作目录 → 自动生成工具」，也没有人格在场模型 |
| Hanzo Bot（MIT，内含 OpenClaw） | 本地 gateway，WhatsApp / Telegram / Slack / Discord / Signal / iMessage / Matrix / IRC / Teams 等；README 明确写 prompt injection 是真实风险 | 有「个人助理 + 多渠道 + 风险意识」；但没有按人分级的 capability 模型 |
| LangBot | 多平台适配器 + RuntimePipeline 流水线 + **`/mcp` 把服务层暴露成 agent 工具** + Web 管理面板 | 最接近「统一 adapter + 工具暴露 + GUI」；但适配器与工具是分开两套，不是一份动作目录 |
| Koishi / NoneBot2 | adapter 生态 + 协议标准（OneBot 11/12、Satori、Milky）+ 消息段模型 + 中间件 | 有协议与消息抽象，**没有 agent 宿主语义**（无 session / event、无 agent 作用域工具） |
| AstrBot | OneBot 系机器人框架（DSH 侧有 `dsh-astrbot-ingress` 反向接入） | 反向接入的例子：说明「别人做前端、DSH 做大脑」这条路是通的 |
| dsh-workspace-mesh（本机自研） | 跨机工作区网格 + 租约 fencing + 插件供给 + 跨节点插件间原语（bus 平面 spike） | 提供「身体」与「搬家」的能力，缺人格语义 |

**结论**：组件都有先例可抄，但「DSH / Cordis 宿主 + 动作目录自动生成工具 + 人格在场集合 + 每消息 capability token + 记忆版本化」这个组合没有人做过。

### 三条最影响设计的市场事实

1. **生态没有统一的适配器层**：`dsh-im` 是事实标准；`dsh-im-gateway` 是唯一有显式 `ChannelAdapter` 接口的，但停更、无人复用其接口；官方包里没有任何 IM / 渠道抽象包 —— **官方刻意通道无关，适配器留给社区**。这正是本设计要占的位置。
2. **并装多个 IM 插件会真冲突**：`dsh-user-approval` 要求「每部署一个最终应答者，同级监听器顺序不是优先级机制」，而生态里 4 个插件各写了一个 `approval/request` 监听器 → 「答了但工具仍被拒」。故定为红线。
3. **OneBot 12 全生态零支持**，而 Lagrange v2 官方已放弃 OB11 改推 Milky → 内核必须平台无关，协议只是 driver。

具体数值（star、下载量、包数量）是快照，见[快照口径](../reference/sources.md#快照口径)。
