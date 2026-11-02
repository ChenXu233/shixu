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
| 建 agent | `ctx.agents.create({ sessionId, meta:{ cwd }, agentOptions })` | 返回 `{ agent, dispose }`。**唯一能带上 cwd 的入口**；对已存在的 sessionId 抛 `SessionAlreadyExistsError` |
| 恢复 agent | `ctx.agents.resume({ resumeSessionId, agentOptions, setup })` | 返回 `{ agent }`，不是 agent 本身。**没有 cwd 参数**，会话的 cwd 建好之后不再变；对没有落盘的 id 抛 `SessionPersistenceNotFoundError`，**不会替你新建**（只有 agent-loop 给自己那条配置身份准备的 `restoreOrCreateConfigured` 才会回落） |
| 取回 live agent | `ctx.agents.get(id)` | 直接返回 agent，但只覆盖**活着**的 |
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
| 会话事件 | `ctx.root.on('session/event', (session, event) => …)` | **挂在根上下文**：事件从会话服务那里发出，插件自己的 ctx 是它的兄弟、不是祖先。`assistant/message` 的 data 是 `{ turn, step, message, stream, usage?, interrupted? }`，人话在 `message.content` 里 `{ type: 'text', text }` 那些块；`turn/end` 的 data 是 `{ turn, reason }`。一轮工具循环会有多条 `assistant/message`，要回一句话就得按 `turn/end` 聚合 |
| 凭据 | `ctx.credentials`：`credentialRef`（密钥）/ `credentialKey`（记录：grant \| api-key \| env） | `describe` 永不返回值；`modifyRecord` 是记录唯一写路径 |
| 持久 | `ctx.storageDomain` | 插件自有数据 |

## Web UI 客户端插件

设置页里的一个分区不是"再写个页面"，是往既有槽位里注册一个组件。要的东西一共四样：

| 位置 | 内容 |
|---|---|
| `package.json` | `dsh.client = { platform: 'web', inject: [...] }` + `exports["./client"]`；缺导出会被 client-modules 直接拒 |
| `client/client.js` | `window.__ModuleLoader__.load({ id: <包名>, factory })`，id 必须等于包名 |
| 工厂返回值 | `{ inject, apply }`；`inject` 里是客户端服务名，缺一个整个模块不激活 |
| `apply(ctx)` | `ctx.slots.inject(槽位名, () => ctx.slots.register(选项, 组件))`；资源用 `ctx.effect` 注册并返回清理函数 |

三条实测出来的约束：

- **资源路由只发 `client.js` 与 `client.*.js`**。`/plugins` 按 `CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` 匹配，再加上 combo 查询只拼 `<id>/client.js`。所以包里的 `locale/*.json`、图片、样式表**浏览器都取不到**；官方包是把文案字典在构建期内联进 client.js 的。不打算上打包器，就把字典写成 `ctx.locale.register(ns, { zh, en })` 的对象字面量。
- **`settings.section` 的 `label` 可以是 thunk**（`string | (() => string)`），文档写明每次投影重读 —— 所以本地化标题不需要自己订阅语言变化。
- **React 不在包里**，从 factory 的 `require('react')` 取；写 `React.createElement` 还是 JSX 由你有没有构建步骤决定，与本条无关。

## 设置页的原生表单

> **文档在哪**：`@deepseek-ai/dsh-client-ui-primitives` 是一个独立 npm 包，版本与 dsh 相同。镜像里它是浏览器虚拟模块、没有源码，但 `npm pack` 下来就有 `lib/types/**/*.d.ts` 的 JSDoc —— 那是唯一权威的字段签名，别再靠运行时试。

自己画设置页会立刻和 DSH 长得不一样。原生那套是这样分的：

| 部件 | 来源 | 作用 |
|---|---|---|
| `SettingsForm` | primitives | 表单外壳：保存页脚、只读提示、保存失败提示。**没有放弃控件**（离开页面即丢弃） |
| `SettingsValueField` | primitives | 一个字段：标签、帮助气泡、覆盖徽章、恢复继承值、非法态。它自己画输入框 |
| `ConfigField` | primitives | 更底层的受控字段（`value/secret/choices/onChange`），不经过表单模型时用 |
| `SettingsFormModel` | primitives | 暂存、脏标记、校验、保存 |
| `ctx.configForms` | 客户端服务 | `get(ns)` 给 scope，`whileServed([ns], fn)` 把槽位挂到"配置可服务"上 |

关键签名（回读安装包 + 运行时探针得到的）：

```text
SettingsForm        { state, labels, onSave, onDiscard, children }
                    state  = { available, writable, dirty, invalid, saving, failed }
                    labels = { unavailable, readOnly, saveFailed, save, saving }
SettingsValueField  { id, label, hint?, help?:{label,content}, numeric?,
                      text, overridden, invalid,
                      overriddenLabel, resetLabel, invalidLabel,
                      disabled, onEdit(text), onReset() }
SettingsFormModel   new SettingsFormModel(scope, textSpecs, secretSpecs)
                    field(name) → { text, overridden, invalid }
                    shell() → 上面那个 state；actions() → { edit, resetField, save, discard }
                    bind(fn) → store
settingsTextField(name) / settingsNumberField(name) → { field, format, parse }
secretSpec          { field, write(text) → Promise<boolean> }   只写，读不到原值
scope               ctx.configForms.get(ns).getSnapshot() → { status, value, base, user, revision, writable }
```

**slot 注入怎么变成组件 props**：`inject()` 里返回的 `hooks: { shixuForm: store }` 会被框架变成
**`useShixuForm(selector)`** 这个 hook prop —— 必须传选择器，不传会抛 `selector is not a function`；
`edit / resetField / save / discard` 则是直接 props。照 `hooks.xxx` 去取会取不到，而且异常会把整个设置面板带崩。

一条踩过的坑：**`SettingsValueField` 不吃 children**。把 `<Input>` 塞进去，标签会渲染、输入框是空的——它按 `...field` 的 `text/overridden/invalid` + `onEdit` 自己画控件，所以必须配 `SettingsFormModel`，绕不过去。

## 设置面（`ctx.remote.settings`）

`describe()` 一次性给出本 profile 里**每个可配置行**的当前状态，实测返回：

```text
{ ok: true, value: { writable, hasDocument, namespaces: [ {
    ns,            // = profile patch 里那一行的 id（不是包名）
    autoGenerate,  // true = 表单由插件导出的 Config 投影而来
    value,         // 生效值：默认值已填，未设置的字段直接不出现
    base,          // 基线
    user,          // 用户覆盖过的那部分
    applies,       // "live" = 改完即生效，不用重启
    secrets,       // [{ path: ['accessToken'], set: true }] 只报"设置过"，不给值
    revision,      // 乐观锁，写回时原样带回
} ] } }
```

四条从真实输出里确认的规矩：

- **只有 `.volatile()` 的字段进表单**。同一行里没标 volatile 的字段（例如驱动的 `platform`）在 `value` 里根本不出现 —— 它是身份，不是可调项。
- **`ns` 是行 id，不是包名**。一个包挂两行就是两个命名空间。
- **密钥只报状态不报值**：`secrets[].set` 说"这个位置配过了"，值永远是掩码。面板不能把掩码当真实值写回去。
- **`applies: "live"` 意味着不用重启**。写回成功即生效，验证时不要重启容器去"让它生效"，那会掩盖真正的问题。

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
