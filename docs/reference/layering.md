# 分层与 bundle 形态

> **状态**：已决议
> **日期**：2026-10-31
> **读者**：任何要判断「这段代码属于哪一层」的人
> **上游材料**：[DSH 接缝与硬约束](dsh-seams.md)
> **口径**：层名、层职责、bundle 名是冻结的；bundle 内部的包划分由实现决定

本页是「东西放哪一层」的唯一答案。其他文档提到层时只写 `L0`–`L4`，不重述本表。

| 层 | 职责 | 形态 |
|---|---|---|
| L0 DSH Core | agent · session log v4 · tools · systemPrompt · approval · schedule · goal · credentials | 不改动 |
| L1 渠道内核 Channel Core | 统一事件模型 · 账号注册表 · 会话绑定 · 动作目录→工具 · 唯一审批应答者 · 提问桥 · 限流去重 · 凭据落位 | bundle `dsh-channel-core`（provide `channels`） |
| L2 适配器层 Driver | 一个平台一份实现：协议归一化 · 动作目录 · 能力声明 · 编码分片 · 降级留痕 | bundle `dsh-driver-<protocol>` |
| L3 人格引擎 Persona | 人格工作区 · 在场集合与注意力 · 跨场所记忆 · 沙箱与产物交付 · capability 权限 · 记忆版本化与做梦 · 复制与迁移 | bundle `dsh-persona` |
| L4 人格包 | 人设 · 人格配置 · 记忆 · 场景（群聊 / 私聊）· 渠道提示词覆盖 | 可分发单元 |

自下而上，每一层只依赖下一层的公开契约。

```text
L4  人格包              人设 · 配置 · 记忆 · 场景
L3  dsh-persona         人格工作区 · 在场集合 · 跨场所记忆 · 沙箱与发布 · 权限
L2  dsh-driver-*        每平台一份：OneBot 11 / OneBot 12 / Satori / Milky / 原生
L1  dsh-channel-core    统一事件模型 · 账号注册表 · 会话绑定 · 动作目录→工具 · 唯一审批应答者
L0  DSH Core            agent · session log · tools · systemPrompt · approval（不改动）
```

## 分发

沿用 DSH 既有模型：`dsh.bundle.patch` → `dsh.profile` 的有序 bundles 组合。`dsh-channel-core` 是一个 bundle（`dsh.bundle.patch` + `cordis.patch.yml`），各 driver 是独立 bundle，由 profile 的有序 bundles 组合。

**profile 里装哪几个 driver，就是这个机器人支持哪些平台。** 平台能力不在代码里写死，在 profile 里选。

## 边界

- **L1 不认识具体平台**：它只见 `ChannelDriver` 接口（见[渠道内核契约](contracts-channel.md#actiondescriptor-与-channeldriver)）。
- **L3 不认识具体渠道**：发布、记忆、注意力都与渠道无关，渠道只负责把文本和 URL 送出去。
- **L2 不持有业务状态**：账号注册表、会话绑定、去重都在 L1，driver 可随时重启。
