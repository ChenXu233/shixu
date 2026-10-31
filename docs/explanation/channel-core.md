# 渠道内核：为什么整层只有这几块

> **状态**：已决议
> **日期**：2026-10-31
> **读者**：写 `dsh-shixu-channel`、或要判断「这块该不该放进内核」的人
> **上游材料**：[渠道内核契约](../reference/contracts-channel.md)、[判据与默认值](../reference/policies.md)
> **口径**：讲取舍与生态证据；字段定义见契约页

L1 的体积必须小到能一眼看完。它存在的理由只有三条：**收敛平台差异**、**独占两个不可分享的资源**（审批应答、凭据）、**给降级留痕**。

## 为什么审批应答者只能有一个

生态调研抓到的最危险冲突：`dsh-user-approval` 明确「每项部署应组合**一个**最终应答者，同级监听器顺序**不是**优先级机制」，而 `dsh-qqbot`、`dsh-im-gateway`、`dsh-wechat`、`dsh-bridge` 各实现了一个 `approval/request` 监听器 —— 并装会出现「答了但工具仍被拒」。

所以内核独占这件事，具体做法：

- **只有 `dsh-shixu-channel` 实现 `approval/request` 的应答者**，driver 不得自己监听；
- 核心层收到审批请求 → 找到该 agent 所属渠道会话 → 推到聊天里 → 等「批准 / 拒绝」；
- 校验「聊天与会话归属」，防止别群 / 别会话冒批；
- 超时回落本机审批体系（`ctx.approval` 自身策略）；
- 审计走 `approval/asked`、`approval/decided`。

同理 `ask_user_question` 的问答也由核心层做双向桥：Web 与 IM 同时收到，先到的有效答案生效，其余渠道收到已回答通知。

命令面同理：`/bind`、`/continue` 这类渠道命令由核心层统一注册到 `ctx.commands`（命令不产生模型消息），driver 只提供「这个平台支持哪些命令」的能力描述。

这条已写成红线，见[判据与默认值](../reference/policies.md#红线)；决策过程见 [ADR-0003](../adr/0003-single-approval-answerer.md)。

## 为什么凭据是最脏的一块

生态现状：几乎所有 IM 插件把 token 明文写进 `cordis.patch.yml` 或插件自有目录（`dsh-qqbot` 的 `setup/persist.ts`、`dsh-im` 存 profile、`dsh-aurabot-qq` 存 `plugins-data/aurabot/`、`dsh-qq-bridge` 写 `profiles/web/cordis.patch.yml`），绕过 `ctx.credentials` 的记录空间 —— 不进凭据管理界面，无法集中撤销或审计。

本设计：账号的 `credentialsRef` 指向 `ctx.credentials` 的记录空间（kind: `api-key` / `grant`），`modifyRecord` 是唯一写路径；浏览器只拿二维码、Manifest、脱敏状态；手动输入的 Secret 单向提交给本机 Host，任何响应不回显 Secret / Token / 用户原始标识。

## 为什么降级必须留痕

用户在 Discord 看到纯文本，却不知道为什么图片没发出来 —— 这类问题只能靠降级记录定位。所以 `SendResult.degradations` 不是调试信息，是产品的一部分：每一次「原生能力不可用、走了替代路径」都要能被用户和运维看见。

降级链与限流的实现契约见[渠道内核契约](../reference/contracts-channel.md#降级观测限流)。
