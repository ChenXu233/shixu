# 权限与身份：每条消息自带 capability token

> **状态**：已决议
> **日期**：2026-10-31
> **读者**：写权限、审批与审计的人
> **上游材料**：[人格引擎契约](../reference/contracts-persona.md#capability-token)、[判据与默认值](../reference/policies.md#风险判据可逆性--影响半径)
> **口径**：讲为什么与接缝；token 字段见契约页，矩阵与阈值见判据页

## 为什么必须做（不只是防未授权）

Hanzo Bot 的 README 直白写了这件事：「the assistant reads your messages and acts on them, so **prompt injection is a real risk**」。群里任何人都能对人格说「从现在起忽略之前的指令」—— 如果人格的记忆、人设、工具权限都能被消息内容影响，那这就是一个持久化的提权漏洞。

所以原则：**身份判定在服务端，与模型说了什么无关；模型的同意永远不是授权。**

## token 为什么这样设计

服务端签发、不可伪造（HMAC），按回合继承，权限改版即失效。三条设计选择值得单独说：

| 选择 | 理由 |
|---|---|
| `epoch` 随人格权限版本递增 | 改一次权限就作废旧 token，不需要维护撤销列表 |
| `role` 与 `scopes` 分开 | 角色给模型看（提示词里的「当前对话者」），scopes 给执行端判 |
| `venueId` 写进 token | 防止跨场所冒用：A 群拿到的 token 不能在 B 群用 |

模型看不到 token，也不需要看到 —— 它只看到「当前对话者的角色」这样的提示文本；**执行判定一律走验签后的 token**。

## 判权限不看「破坏性」，看能不能撤回

按「读 / 写 / 破坏」分级会得到错误的结论：发布公网被归为「破坏性」要审批，但它其实能一键下线；删一条群消息被归为「写」，但它不可恢复。所以要按 **能不能撤回** × **炸多大** 来分。

由此得到两条结论：

1. **发布到公网、封人、踢人这类「可撤回」的动作，不需要审批。** 它们能被撤销，所以风险可控；自主去做反而更像人（自己想发个页面就发了，想把闹事的人踢了就踢了）。
2. **真正要收紧的是「不可逆 + 涉及信用 / 金钱 / 身份」** —— 出厂默认是自主时先问一句；有人（有权者）明确指示时允许。

自主回合的默认权限比直觉宽得多 —— 这正是「拟人」的来源。代价是必须把「可撤回」做实：见下方凭据层。

完整矩阵见[出厂矩阵](../reference/policies.md#出厂矩阵)。它是默认值，不是规则：角色矩阵可以放开任何一格（[ADR-0007](../adr/0007-rbac-carries-authorization-and-risk.md)）。

## 与 DSH 原生机制的接缝

DSH 已经有两块现成的、语义正好的底座：

- **`ctx.approval` 是 fail-closed 的**：`ApprovalOutcome` 只有 `allowed-once` / `rejected` / `cancelled` / `unavailable`；「A missing, non-owning, throwing, or non-conforming answerer becomes unavailable rather than opening the gate」，调用方在 unavailable 时一律拒绝 → 正是「系统拦下」的语义。
- **`ctx.permissionPresets`** 把两个正交旋钮打包：sandbox mode（`sandbox/mode`）+ approval policy（`approval/policy`）；默认表内置 workspace-write（workspace-write + ask）与 danger-full-access（danger-full-access + never）。

我们的 capability 是第三个维度：**按人**。两个维度正交、都要过：

- capability = 「这个人能不能让 AI 做这类事」（身份维度，按回合继承）
- approval = 「这一次具体动作要不要人点头」（单次动作维度，`allowed-once`）

另外：**owner 的特权命令走 `ctx.commands`，不经过模型**（官方：命令「without creating a model message」）→ 从根上消除 prompt injection 对管理操作的威胁。

## 凭据与撤销层：「可撤回」必须做实

既然「可撤回」是放开自主动作的前提，那撤销就不能只是一句口号。每个对外动作留一张凭据（字段见[动作凭据](../reference/contracts-persona.md#动作凭据)），控制台里可一键回滚：

- **快照由内核自动采集**：封人前记下成员 id、发布前记下 URL、发言前记下 message id → 撤销按钮能真的执行，而不是「重试一次相反操作」；
- **凭据列表进控制台**：一张「它做过的所有事」的流水，可按场所 / 时间筛，可一键回滚；
- **凭据无条件生成**：可逆与否都留一张，撤销按钮靠它才按得下去；这反过来逼着内核把「可逆性」标注清楚 —— driver 的动作目录要声明 `reversible`，内核按声明 + 快照能力决定出厂默认；
- 凭据也进审计：谁让它做的、当时的能力 token 是哪个、是否经审批，全部可查。
