# 决策登记

> **状态**：生效中
> **日期**：2026-10-31
> **读者**：动手前要确认「这件事被决定过吗 / 被否决过吗」的人
> **上游材料**：[路线图](../roadmap.md)
> **口径**：本页只记决策状态；落地进度只看[路线图](../roadmap.md)，不在本页另建进度表

ADR 记录的是「某一天我们决定了什么」，是历史事实：**正文不可改，只能改状态**。改主意就新写一篇，把旧的一篇标为 `superseded` 并写明被谁取代。

## 两轴状态

| 轴 | 取值 | 含义 |
|---|---|---|
| 决策状态 | `proposed` / `accepted` / `rejected` / `superseded` / `deprecated` | 这个决定算不算数 |
| 落地阶段 | P0 / P1 / P2 / P3 / P4 / — | 哪个阶段交付它；具体进度看路线图 |

只有一轴时会出现「ADR 还写着旧实现、代码已经改了」——读者无法判断哪个是真的。所以两轴都要有。

## 已决议

| # | 决策 | 结论 | 状态 | 落地阶段 |
|---|---|---|---|---|
| [0001](0001-risk-criterion.md) | 风险判据 | 可逆性 × 影响半径，不是「破坏性」 | accepted | P0 |
| [0002](0002-memory-repo.md) | 记忆仓库策略 | 全部记忆进版本历史，仓库默认私有，不加密 | accepted | P3 |
| [0003](0003-single-approval-answerer.md) | 审批应答者落点 | 只有 `dsh-shixu-channel` 能应答 | accepted | P0 |
| [0004](0004-grow-by-friction.md) | 插件怎么拆 | 按摩擦拆，不预先规划插件图 | accepted | P1 |
| [0005](0005-driver-per-protocol.md) | 驱动按什么切 | 一种线缆协议一个驱动；平台是身份，不是路由键 | accepted | P0 |
| [0006](0006-capability-two-doors.md) | 未抽象能力怎么进模型视野 | 两条门：动作目录 + MCP；MCP 不是降级 | accepted | P2 |
| — | 涉及信用的动作类别 | 六项统一归「不可逆 + 高影响」（见[能力矩阵](../reference/policies.md#能力矩阵)） | accepted | P0 |
| — | 人格与场所 | 唯一一人格；场所多个且可同时在场 | accepted | P2 |
| — | 跨场所广播 | 延迟投递不打断：运行中的场所 `steer()`，空闲场所靠读穿 | accepted | P3 |
| — | 权限模型 | 每条消息自带服务端签发的 capability token，按回合继承，三层收紧 | accepted | P0 |
| — | 发布能力 | 属人格层：Publisher 抽象 + `persona_deploy`；四档交付降级链 | accepted | P3 |
| — | 记忆版本化 | 人格工作区即 git 仓库；夜间做梦整理并提交 | accepted | P3 |
| — | 消息模型 | 扁平 canonical 段 + native 透传；渠道来源走消息前缀，不用 source kind | accepted | P0 |
| — | 人格可迁移 / 可复制 | 人格 = mesh 上的一个工作区，身体 = 拥有它的节点 | accepted | P4 |

正文在这里，理由在这里：

- 信用六项与能力矩阵 → [判据与默认值](../reference/policies.md#风险判据可逆性--影响半径)
- 人格与场所 → [人格与场所](../explanation/persona-presence.md)
- 广播 / 记忆同步 → [跨场所记忆](../explanation/memory.md)
- 权限模型 → [权限与身份](../explanation/permission-identity.md)
- 发布与降级链 → [沙箱与产物交付](../explanation/sandbox-delivery.md)
- 消息模型 → [渠道内核契约](../reference/contracts-channel.md)
- 迁移与复制 → [复制与迁移](../explanation/replication.md)

## 待拍板

全部给了默认值 —— 不回复就按默认值实现，改起来都不贵。**默认值本身只有一个家**：[默认参数](../reference/policies.md#默认参数)。

| # | 待定事项 | 现行口径 | 状态 |
|---|---|---|---|
| 1 | 协议形态：只做进程内 TS driver，还是出公开线缆协议（让 Go / Python / NapCat 直接当 driver） | 进程内 TS，P3 再评估（[生态](../explanation/ecosystem.md#线缆协议dsh-已有-typert)） | proposed |
| 2 | 消息模型：扁平 canonical + native 透传，还是 Koishi 树形以支持嵌套卡片 | 扁平（[契约](../reference/contracts-channel.md#统一事件模型)） | proposed |
| 3 | 同时在场数上限与跨场所发言节奏：全局严格轮流，还是允许穿插 | `attention.cap` = 3，发言串行 | proposed |
| 4 | 忙碌期间入站消息处置：静默排队 + TTL / 忙完统一处理 / 只做零成本反应 / 直接丢弃 | 排队 + TTL | proposed |
| 5 | 跨场所记忆转授权默认粒度：private 不可外传 / 允许模型自动转述 / 逐条批准 | 不可外传 | proposed |
| 6 | 全局速率与每日预算默认值 | 见[默认参数](../reference/policies.md#默认参数) | proposed |
| 7 | 发布站点默认可见性 | `token`（链接 + 随机口令），公开需主人批准 | proposed |
| 8 | 身份绑定方式 | 手动 owner 列表 + 配对流程，两者都要 | proposed |
| 9 | 无权限者怎么对待 | 能正常对话但受限：只读工具 + 只能写本场所记忆 | proposed |
| 10 | 单主单活还是多副本常驻 | 单主单活：一具持租约的身体连 channel，其余 warm standby | proposed |
| 11 | 门 B（MCP）工具的风险从哪来 | 驱动用 `mcpServers[].risk` 逐 server 声明，未声明按 `destructive` 处置 | proposed |

## 什么时候写 ADR

| 情况 | 动作 |
|---|---|
| 改变已 `accepted` 的决策 | 先写新 ADR、标旧的一篇 `superseded`，再改代码与文档 |
| 引入新的架构边界（新层、新进程、新持久化） | 写 ADR，登记进本表 |
| 只是实现细节变了（函数、字段名） | 不写 ADR，改契约页 |
