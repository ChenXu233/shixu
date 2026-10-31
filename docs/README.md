# 文档导航

> **状态**：生效中
> **日期**：2026-10-31
> **读者**：所有要读 / 写文档的人
> **上游材料**：[仓库 README](../README.md)、[AGENTS.md](../AGENTS.md)
> **口径**：本页是全仓唯一索引；不另建第二份导航

**先看结论**：本仓库只有设计，没有代码。设计不是一份大文档，而是按「读完要产出什么」分开的四类材料 —— 能跑的东西、能完成的任务、能查到的答案、能下的判断。

## 读法

| 你的角色 | 必读 | 可跳 |
|---|---|---|
| 写 driver 的人 | [DSH 接缝](reference/dsh-seams.md) · [渠道内核契约](reference/contracts-channel.md) · [渠道内核：为什么](explanation/channel-core.md) | `explanation/` 下人格相关 |
| 写渠道内核的人 | [DSH 接缝](reference/dsh-seams.md) · [渠道内核契约](reference/contracts-channel.md) · [判据与默认值](reference/policies.md) · [渠道内核：为什么](explanation/channel-core.md) | [跨场所记忆](explanation/memory.md)、[复制与迁移](explanation/replication.md) |
| 写人格引擎的人 | [DSH 接缝](reference/dsh-seams.md) · [人格引擎契约](reference/contracts-persona.md) · [人格与场所](explanation/persona-presence.md) · [跨场所记忆](explanation/memory.md) | [生态](explanation/ecosystem.md) |
| 做主人 / 配置的人 | [定位](explanation/overview.md) · [判据与默认值](reference/policies.md) · [路线图](roadmap.md) · [决策登记](adr/README.md) | 契约细节 |
| 评审者 | [路线图](roadmap.md) · [决策登记](adr/README.md) · [判据与默认值](reference/policies.md) | 实现细节 |

只需要一句话判断「这是什么东西」：读[定位](explanation/overview.md)。

## 读法

| 你的角色 | 必读 | 可跳 |
|---|---|---|
| 写 driver 的人 | [DSH 接缝](reference/dsh-seams.md) · [渠道内核契约](reference/contracts-channel.md) · [渠道内核：为什么](explanation/channel-core.md) | `explanation/` 下人格相关 |
| 写渠道内核的人 | [DSH 接缝](reference/dsh-seams.md) · [渠道内核契约](reference/contracts-channel.md) · [判据与默认值](reference/policies.md) · [渠道内核：为什么](explanation/channel-core.md) | [跨场所记忆](explanation/memory.md)、[复制与迁移](explanation/replication.md) |
| 写人格引擎的人 | [DSH 接缝](reference/dsh-seams.md) · [人格引擎契约](reference/contracts-persona.md) · [人格与场所](explanation/persona-presence.md) · [跨场所记忆](explanation/memory.md) | [生态](explanation/ecosystem.md) |
| 做主人 / 配置的人 | [定位](explanation/overview.md) · [判据与默认值](reference/policies.md) · [路线图](roadmap.md) · [决策登记](adr/README.md) | 契约细节 |
| 评审者 | [路线图](roadmap.md) · [决策登记](adr/README.md) · [判据与默认值](reference/policies.md) | 实现细节 |

只需要一句话判断「这是什么东西」：读[定位](explanation/overview.md)。

## 目录

```text
docs/
├── README.md          本页：唯一索引
├── roadmap.md         路线图：唯一一份进度表
├── reference/         信息导向：查字段、查判据、查默认值
├── explanation/       理解导向：为什么这样设计
└── adr/               决策日志：某一天决定了什么
```

四象限的另一半**故意没有建**：

| 象限 | 何时建 | 判据 |
|---|---|---|
| tutorial（学习导向） | 出现「15 分钟从零跑起一个 bot」的需求时 | 有人在没有上下文的情况下独立跑通 |
| how-to（任务导向） | P1 跑通、出现第一个部署 / 改协议 / 排障任务时 | 同一件事被问第二次 |

空目录是噪声，且会诱使 agent 往里凑内容。要建之前先改这张表。

## 参考（reference）

| 文件 | 一句话 |
|---|---|
| [layering.md](reference/layering.md) | L0–L4 各层边界与 bundle 形态 |
| [dsh-seams.md](reference/dsh-seams.md) | DSH 给了什么、六条硬约束、原语落点 |
| [contracts-channel.md](reference/contracts-channel.md) | 事件模型、动作目录、账号绑定、降级 |
| [contracts-persona.md](reference/contracts-persona.md) | 工作区布局、在场、token、凭据、发布器、控制台 |
| [policies.md](reference/policies.md) | 红线、风险判据、能力矩阵、默认参数 |
| [sources.md](reference/sources.md) | 出处、调研登记、快照口径 |

## 解释（explanation）

| 文件 | 一句话 |
|---|---|
| [overview.md](explanation/overview.md) | 定位与「和已有方案的区别」 |
| [channel-core.md](explanation/channel-core.md) | 为什么只有内核能应答审批、凭据为什么最脏 |
| [persona-presence.md](explanation/persona-presence.md) | 一次人格、多个场所、注意力预算 |
| [memory.md](explanation/memory.md) | 记忆分层、读穿、广播、git、做梦 |
| [sandbox-delivery.md](explanation/sandbox-delivery.md) | 沙箱边界、四档交付、发布管线 |
| [permission-identity.md](explanation/permission-identity.md) | 为什么判权限不看「破坏性」 |
| [replication.md](explanation/replication.md) | 人格 = 工作区，身体 = 机器 |
| [ecosystem.md](explanation/ecosystem.md) | 协议供给风险与开源对照 |

## 决策与进度

| 文件 | 一句话 |
|---|---|
| [roadmap.md](roadmap.md) | P0–P4 阶段、完成判据、每阶段协议 |
| [adr/README.md](adr/README.md) | 决策登记（两轴状态）+ 待拍板清单 |
| [adr/0001-risk-criterion.md](adr/0001-risk-criterion.md) | 权限判据改用「可逆性 × 影响半径」 |
| [adr/0002-memory-repo.md](adr/0002-memory-repo.md) | 全部记忆进版本历史，仓库默认私有 |
| [adr/0003-single-approval-answerer.md](adr/0003-single-approval-answerer.md) | 审批应答者只能有一个且在内核 |

每份文档开头都有自己的状态与日期，本页不重复。

## 三步规则

1. **不要新增文件，先问能不能折进已有文档的某一节。** 默认答案是折进去。
2. **同一事实只写一处。** 要引用就写链接；第二个副本是 bug，不是冗余容忍。
3. **只写当前状态。** 历史交给 git：不写「以前是」「已改成」，不建归档目录。

改哪份文档、事实归谁管，见 [AGENTS.md 的同步矩阵](../AGENTS.md)。