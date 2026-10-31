# ADR-0003：审批应答者只能有一个，且必须在内核

> **状态**：`accepted`
> **日期**：2026-10-30
> **落地阶段**：P0
> **上游材料**：[渠道内核：为什么整层只有这几块](../explanation/channel-core.md)

## 背景

生态里 `dsh-qqbot`、`dsh-im-gateway`、`dsh-wechat`、`dsh-bridge` 各自实现了一个 `approval/request` 监听器。而 `dsh-user-approval` 的官方口径是：每项部署应组合**一个**最终应答者，同级监听器顺序**不是**优先级机制。

并装多个的结果是「答了但工具仍被拒」—— 用户明明点了批准，工具还是被拦。这是生态里最容易被误判为「插件有 bug」的一类问题。

## 决策

**只有 `dsh-channel-core` 实现 `approval/request` 的应答者，driver 不得自己监听。**

内核收到审批请求后的完整链条：

1. 找到该 agent 所属渠道会话；
2. 推到聊天里；
3. 等「批准 / 拒绝」；
4. 校验「聊天与会话归属」，防止别群 / 别会话冒批；
5. 超时回落本机审批体系（`ctx.approval` 自身策略）；
6. 审计走 `approval/asked`、`approval/decided`。

同理扩到另外两处：`ask_user_question` 的双向桥由内核做（Web 与 IM 同时收到，先到的有效答案生效），渠道命令由内核统一注册到 `ctx.commands`（命令不产生模型消息），driver 只声明能力。

## 被否决的替代

- **允许 driver 自行应答**：能省一层转发，但并装即冲突，且无法校验会话归属（群 A 能批群 B 的请求）。
- **按优先级排序多个应答者**：官方明文说顺序不是优先级机制，这条路根本不存在。

## 影响

- driver 契约里没有 approval 相关方法，driver 作者不需要知道审批存在；
- 内核体积增加一处，但换来「并装任意组合的 driver 都不冲突」；
- 这条是红线，评审时可直接搜 `approval/request` 监听数来验证。
