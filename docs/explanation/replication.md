# 复制与迁移：人格有身体，身体能搬家

> **状态**：已决议（跨机部分依赖 dsh-workspace-mesh 的阶段进度）
> **日期**：2026-10-31
> **读者**：写人格复制 / 迁移的人
> **上游材料**：[路由与阶段](../roadmap.md)、[跨场所记忆](memory.md)
> **口径**：讲三层拼装；mesh 的协议细节在对方仓库

> 底座：已有的 [dsh-workspace-mesh](https://github.com/ChenXu233/dsh-workspace-mesh)（mesh 是**工作区**的网格，不是 agent 的网格；agent loop 永不离开拥有该工作区的机器）。

## 人格 = 网格上的一个工作区，身体 = 拥有它的那台机器

mesh 的核心前提「agent loop never leaves the machine that owns the workspace」正好就是「人格有身体」的语义：

- **personaId 全局唯一** → 副本是**身体**，不是分身（分身是另一个 personaId）；
- 人格工作区 = mesh 里的一个 workspace（cwd = 人格目录，git 仓库）；
- **家在哪儿** = mesh 的 assignment（workspaceId → nodeId）；
- **它是醒着的那具身体吗** = board 的租约。

## 复制 = 四个动作（mesh 提供其中三件）

| 步骤 | 谁执行 | 用什么 |
|---|---|---|
| ① 申请资源 | 人格发起，主人批准 | capability（花钱 = 信用六项）+ 出站投递 |
| ② 备身（新机具备运行能力） | 旧机 | SSH / scp（凭据在 `ctx.credentials` 记录空间）+ mesh 的插件供给流程 |
| ③ 搬记忆 | 旧机 | `git push`（人格工作区本身就是仓库） |
| ④ 交接在场 | 新旧两机 | channel handover（断旧连新）+ assignment 改归属 + board 租约转移 |

第 ① 步是拟人感最强的地方：**它可以提方案、申请，但不能自己刷卡** ——「我需要一个 2C4G、每月 20 块，理由是…」，主人点头后它自己去开通并部署。

## 主体仲裁：board 租约 + fencing

- 每个 persona 在网格上持有一份**租约**（node + fencing token）；
- **只有持租约的那具身体**可以：写记忆、连 channel、执行授权动作；
- 其它副本 = warm standby（能被派活查记忆、能接只读任务，但不说话）；
- 租约转移 = fencing 递增 → 旧副本的提交必被拒 → **经典脑裂在协议层就被挡掉**；
- 「同一个人手机和电脑都有自己」= 同一 personaId 多具身体、共享同一份 git 记忆、但只有一个能说话。

## mesh 给了什么 / 没给什么

边界要清楚，否则会在 P4 反复踩空：

| mesh 给 | mesh 不给（要靠别的东西补） |
|---|---|
| roster / node / endpoint（目标机已在网格里） | **文件搬运** —— `WorkspaceSummary` 仅元数据，数据面方法白名单硬编码，无 bash / 无文件访问 |
| assignment（workspace → node 归属） | **凭据与密钥迁移**（QQ appSecret、GitHub token、persona 的 HMAC secret） |
| 插件供给（远端 node 具备运行该工作区所需的能力） | **channel 同号交接**（同一个 QQ 号不能两机同时在线） |
| board 租约 + fencing（主体仲裁、抗脑裂） | **身份连续性**（personaId + 签名密钥要能跨机验签） |
| identity：epochKey / requestToken / ReplayGuard（跨机请求鉴权 + 防重放） | |
| lifecycle（实例运维三条路径 + 状态机与安全红线） | |
| 三平面协议 + 断线重连 / 并发 / 超时语义 | |

所以「复制自己」= **mesh 负责「家在哪、谁是主、怎么派活」，git 负责搬记忆，SSH + 凭据负责备身**。三层拼起来才完整 —— 也正好符合 mesh「数据面严格隔离」的原则：搬文件这种重操作不该走消息网格。

## 它知道自己搬了家

- 场所 agent 的 prompt 注入**当前身体**：节点标签、所在区域、已在线多久；
- 迁移完成后主动通知主人：「我搬到腾讯云了，QQ 号还是那个，记忆都在，现在 24 小时在线，你电脑关机我也在」—— 这是「更像人」缺的那条腿：人有个身体，身体能搬家；
- 交接必然有断线窗口（同号要断旧连新）→ 场所的 pending 队列 + eventId 去重能吃掉大部分损失。

## 版本一致性

两边的 DSH 版本、bundle 版本、**session 格式（v4）**必须一致 —— 参照 `dsh-im` 锁 DSH 版本区间的做法，persona bundle 声明 `engines.dsh` 区间，不一致就拒绝接管。
