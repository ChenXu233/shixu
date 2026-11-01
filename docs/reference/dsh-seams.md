# DSH 接缝与硬约束

> **状态**：已决议（实测结论，DSH 版本变动时需重核）
> **日期**：2026-10-31
> **读者**：所有要调 DSH API 的实现者
> **上游材料**：DSH 官方文档与安装包源码，出处见[外部依据](sources.md)
> **口径**：以下结论来自对 DSH 安装包与官方文档的实测；DSH 升级后必须重核本页

本页回答一个问题：**DSH 已经给了什么，我们不能重造什么。** 动手前先读本页，尤其是「硬约束」六条。

## 前提纠偏

生态里流传的说法有三处是错的，按错的写会在 P1 直接卡住：

| 常见说法 | 实测结论 |
|---|---|
| `ctx.sendMarkdown` 是核心 API | **不存在**。全量搜索 DSH 安装命中 0 个文件；它是 dsh-qqbot 内部的 QQ 出站发送器 |
| 插件清单是 `dsh.plugin` | **不是清单字段**。官方唯一支持的挂载声明是 `dsh.bundle.patch`（string \| string[]） |
| `ctx.session` 是会话服务 | **单数不存在**，真实服务名是 `ctx.sessions`（复数） |

另：`ctx.events` 就是 Cordis 事件总线（`on` / `emit` / `waterfall`）。

## 可用的 seam（精确到 API）

| 能力 | API | 备注 |
|---|---|---|
| 建 / 恢复 agent | `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` | **返回 `{ agent }`**，不是 agent 本身；`get(id)` 直接返回 agent，但只覆盖**活着**的。`create()` 只能建新 id，对已存在的 sessionId 会抛错 —— 要「恢复或新建」一律用 `resume()`，它内部先恢复、只有 `SessionPersistenceNotFoundError` 才落到 create |
| 投递 | `agent.followup(userMessage)` —— 参数是**完整的 user 消息对象**（`{ id, role:'user', content, source:{kind:'user'} }`），同步返回 | 只传 `{ content }` 会在运行时抛 `followup is not a function` / 形状错误，而错误被队列吞掉，只剩「agent 建了但一句话没投进去」 |
| 主动注入 | `handle.inject({ content, source })` | **不唤醒**；模型可见上下文 |
| 作用域 | `agent.ctx` | 工具 / 提示词段 / 监听器 / 限制，**只对该 agent 生效**，dispose 自动撤销 |
| 工具注册 | `ctx.tools.register(def)` | 走 `defineTool`：parameters + output.schema + output.render |
| 工具收窄 | `ctx.tools.restrict(filter)` | 只删；`ctx.tools.guard()` 只拒（同步） |
| 审批闸门 | `tools/pre-execute`（可返回 ask，异步征询） | 平台写操作的唯一入口 |
| 审批服务 | `ctx.approval.request(req)` / `setPolicy` | 策略 ask（默认）/ never；审计 `approval/asked`、`approval/decided` |
| 命令 | `ctx.commands.register({ name, description, input, handler })` | handler 返回 `{ kind, text }`；**命令不产生模型消息** |
| 提示词 | `ctx.systemPrompt.section()`；`agent.ctx` 上的 scoped section | per-agent 上下文用 `agent.inject()` |
| 会话 | `ctx.sessions.get/create/fork`；`session.append(type, data, opts?)`、`deriveMessages()`、`flush` | append-only，LLM 历史由日志派生 |
| 凭据 | `ctx.credentials`：`credentialRef`（密钥）/ `credentialKey`（记录：grant \| api-key \| env） | `describe` 永不返回值；`modifyRecord` 是记录唯一写路径 |
| 持久 | `ctx.storageDomain` | 插件自有数据 |

## 硬约束（DSH 官方明文）

违反这六条会在运行时被拒，不是风格问题。

1. **不得用新 type 追加 session 事件**（唯一例外：experimental 包的 `plugin:<owner>/<record>`，且必须 `ignorable:true`）。live `Session.append()` 无法设 `ignorable`，否则 Session 拒绝 reopen。
2. **不要自己订阅 `session/event` 重扫 `session.events` 做状态** → 用 `ctx.sessionProjections` 的纯同步 `apply(state, event)`。
3. **等待用耐久事件**（`turn/end`、`assistant/message`、`tool/result`），实时 token 用 `agent/assistant-stream`；**不要轮询 `agent/status`**；`whenIdle()` 不等于一个 followup 结束。
4. **每条 `UserMessage` 恰一个 `MessageSource`**；多插件合并到一条消息会塌缩成一个 source。
5. **加提示词用 `ctx.systemPrompt.section()`，per-agent 上下文用 `agent.inject()`**；**不要监听 `system-prompt/assemble` 去增删工具**。
6. **initiator scope 是进程内的**：跨进程、HTTP、持久队列、重启必须显式携带身份。

> 第 5 条直接决定了工具作用域的实现方式：按会话裁剪工具集必须走 scoped 注册 / restrict，**不能**在 assemble 阶段动态增删。

## 原语落点表

需求 → 用哪个原语，避免「先自己造一个再发现官方有」：

| 需求 | 原语 |
|---|---|
| 人格项目 | `ctx.workspaceRegistry.create(dir, title)`；hide / restore 控制可见性 |
| 场所会话 | `ctx.sessions.create(id, { meta: { cwd } })` |
| 场所 agent | `ctx.agents.create({ sessionId, parentAgent })` |
| 场所专属工具 / 提示词 | `agent.ctx` shadow tools & prompt sections |
| 主动续轮 | 原生 goal（create / update + `GoalMessageSource`） |
| 定时开口 | `ctx.schedule`（after / at / every / daily / weekly / cron） |
| 主人指令 | `ctx.commands`（命令不产生模型消息） |
| 审批 | `ctx.approval`（内核是唯一应答者） |
| 凭据 | `ctx.credentials` |
| 持久 | `ctx.storageDomain` + 人格目录文件 |
| 延迟广播（不打断） | `handle.steer()`（下一个 step 边界进入）/ `handle.inject()`（不唤醒） |
| 沙箱 | `ctx.sandbox`（SandboxMode：read-only / workspace-write / danger-full-access；Windows 走 ACL restricted-token） |
| 产物交付 | `present` → `PresentedFile`、`workspace-changes` → `WorkspaceChangedFile`（均为 log-only session 事件，插件可订阅后转发到 IM） |
| 仓库内工作 | `ctx.worktrees`（实验性，默认关闭） |
| 静态托管 | 独立服务进程（`ctx.shell` / `ctx.subprocess` / jobs 子系统，`ctx.effect` 回收）；`ctx.webServer` 不适合 |
| 自有域名发布 | Publisher 抽象 + `persona_deploy` 工具 + 内核唯一审批应答者 |
| 权限 | `ctx.permissionPresets`（sandbox mode + approval policy 打包）、`ctx.approval`（fail-closed）、`ctx.tools.restrict` / `guard` / `pre-execute`、`ctx.commands`（owner 特权命令不经模型） |
| 身份 | 自建：每回合解析 `subject` / `role` / `venueId`；判定只读服务端状态，不签名（[ADR-0008](../adr/0008-permission-has-one-source.md)） |
