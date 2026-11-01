# ADR-0006：能力只有两条门，未抽象的东西走 MCP

> **状态**：`accepted`
> **日期**：2026-11-01
> **落地阶段**：P2
> **上游材料**：[渠道内核契约](../reference/contracts-channel.md)、[判据与默认值](../reference/policies.md)

## 背景

统一抽象只能有词表里已经存在的概念。平台每年长出新东西 —— 戳一戳、群文件、语音房、频道分区、线程、Sticker —— 把它们逐个塞进 `UnifiedEvent` / `ActionDescriptor` / `Capabilities`，等于让抽象永远追着平台跑；而且每加一个，所有驱动的编译面都动一次。

但内核又必须知道「这个动作能不能撤、要不要人点头」，否则[红线 5](../reference/policies.md#红线)落不了地。

## 决策

**能力有两条门，都是原始设计。没有「逃生舱」这回事，也不叫降级。**

| 门 | 谁定义 | 怎么进模型视野 | 适合什么 |
|---|---|---|---|
| A 声明式 | `ActionDescriptor` + `Capabilities` | 内核把动作目录翻成 `{platform}_{action}` 工具 | 有统一语义、且内核要据此判断风险与降级的能力 |
| B MCP | 驱动作者自带一个 MCP server | `mcp__<serverName>__<tool>`，由 `dsh-mcp-client` 挂到该场所的 agent 上 | 只有这个平台有、我们没有词表的能力 |

**选哪条门是驱动作者的判断，不是我们的登记表。** 内核不维护「平台能力清单」—— 一旦维护，就又回到「把所有差异都建模出来」。

为什么是 MCP 而不是再造一层抽象：

- MCP 是开放标准，它的进化由协议承担，不占用我们的契约；
- 工具天然带 JSON Schema，接上就能被模型调用；
- DSH 原生支持 **agent 作用域**的 MCP 实例：`dsh-mcp-client` 的 `serverName` 按注册作用域隔离，同一个 `serverName` 可以在不同 agent 复用。这正好对上本项目「1 场所 = 1 agent」，工具不串味。

## 被否决的替代

| 替代 | 否决理由 |
|---|---|
| 持续扩展统一模型 | 抽象永远追不上平台，且每扩一次所有驱动的编译面都动 |
| 用 `raw` / `native` 当能力出口 | 那一对只解决消息**表达**的透传，解决不了**动作**。要执行平台独有动作，必须有工具 |
| 所有平台能力都走 MCP | 丢掉三样内核存在的理由：风险分级、降级留痕、跨平台一致的命名与审批闭合 |

## 影响

两条必须记住的后果：

1. **门 B 的工具默认没有风险分类。** 已回读安装包核实：`dsh-mcp-client` 不读 MCP 的 `readOnlyHint` / `destructiveHint`，而 `dsh-tools` 的 `tools/pre-execute` 默认返回 `allow`。所以驱动必须用 `ChannelDriver.mcpServers[].risk` 逐 server 声明风险，未声明者按 `destructive` 处置 —— 现行口径见[待拍板](README.md#待拍板)第 11 项。
2. **MCP 实例按场所挂载**，因为工具必须是 agent 作用域。stdio 传输等于每个场所一个子进程；驱动应优先提供 `streamable-http`，让一个服务进程被多个场所共用。

## 指针

- 两条门的字段：[渠道内核契约](../reference/contracts-channel.md#两条能力通道)
- 风险默认处置：[判据与默认值](../reference/policies.md#动作风险与默认处置)
