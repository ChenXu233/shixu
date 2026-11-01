# 时煦 · shixu

> 时，日 + 寸 —— 时间。
> 煦，日 + 昫 —— 暖而不烫。
> **时煦：时间沉淀下来的那点温度。**

让一个人格，同时活在很多个聊天平台里。

DSH（DeepSeek Harness）的**渠道内核 + 人格引擎**：驱动把不同协议接进来（OneBot 11 / OneBot 12 / Satori / Milky / 原生 API），人格层让同一个「人」同时出现在多个群与私聊，共享同一份记忆，并且能连同记忆一起搬到另一台机器上。

## 现在是什么状态

**设计已决议，代码刚开始。** 目前只有一条跑通的最小切片：渠道 seam + 一个不出网络的内存 driver。阶段与完成判据见[路线图](docs/roadmap.md)。

## 五层结构

分五层：L0 是不动的 DSH 底座，L1 `dsh-shixu-channel` 收敛平台差异，L2 每种协议一份 driver，L3 `dsh-shixu-persona` 管人格、记忆与权限，L4 是可分发的人格包。边界与依赖方向只写在[分层与 bundle 形态](docs/reference/layering.md)，这里不重复。

## 它不是「一个机器人接了很多平台」

而是「一个人同时活在很多地方」：平台差异收敛成一份**动作目录**，没有词表的能力走 **MCP 工具**，人格差异收敛成**场所**与**分层记忆**。为什么这样设计、和生态里已有方案差在哪，见[定位](docs/explanation/overview.md)。

## 文档怎么进

| 想做的事 | 打开 |
|---|---|
| 判断这是什么东西 | [定位](docs/explanation/overview.md) |
| 开始实现 | [文档导航](docs/README.md) → [分层](docs/reference/layering.md) → [DSH 接缝](docs/reference/dsh-seams.md) |
| 看现在做到哪 | [路线图](docs/roadmap.md) |
| 查字段 / 判据 / 默认值 | [判据与默认值](docs/reference/policies.md) |
| 确认某件事定没定 | [决策登记](docs/adr/README.md) |

全仓唯一入口是 [docs/README.md](docs/README.md)，它按角色给出读法。

## 相关

- [dsh-workspace-mesh](https://github.com/ChenXu233/dsh-workspace-mesh) —— 跨机工作区网格；人格的「身体」与「搬家」能力由它提供。

## 许可

Apache-2.0，见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
