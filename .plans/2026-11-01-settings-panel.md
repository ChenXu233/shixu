# 设置页面板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DSH Web UI 的设置页里给"时煦"加一个分区，能改连接方向与地址、模型的跟随/指定、场所开关；改完即生效，落盘位置仍是 profile patch。

**Architecture:** 三个独立部件串起来：驱动补正向 WS 传输（反向已有）；插件导出 `Config`（volatile）让 host 知道字段与校验；一份手写单文件浏览器模块注册 `settings.section` 槽位，通过 `ctx.remote.settings` 读写与 YAML 相同的那份数据。

**Tech Stack:** TypeScript（tsc 产出 `lib/`）、vitest、Cordis 插件形态、DSH Client 运行时（`window.__ModuleLoader__.load`）、React 取自浏览器模块表。

**Spec:** `docs/adr/0009-settings-panel.md`

## Global Constraints

- 客户端是**单文件** `client/client.js`，不上打包器；用 `React.createElement`，JSX 一律不写。
- 可见文本全部走 locale 服务。字典**内联**在 `client/client.js` 的 `ctx.locale.register('shixu', { zh, en })` 里：浏览器只能从 `/plugins` 拿到 `client.js` 与 `client.*.js`，包的 `locale/*.json` 它读不到，官方包同样是构建期内联。中文只允许出现在字典对象内部，其它字符串保持英文或 key；`locale/*.json` 只放插件清单会读的 `meta`。
- 包内不得含任何个人值（IP、域名、令牌、QQ 号、群号）；示例一律用占位符。
- 不新建设置文件；配置唯一落盘位置是 profile patch 里那一行的 `config`。
- 每个任务结束都能独立验证；提交前 `pnpm test` 全绿。
- 改到 `docs/**` 时跑 `python scripts/check_docs.py`。

## Review Focus

- **方向切换后字段组错位**：选正向却仍显示 `host/port`，用户会以为填了没用。切换时整组重渲染，隐藏的字段不参与提交。
- **并发覆盖**：两个标签页都打开面板，后保存的静默覆盖前者。写回必须带 `expectedRevision`，冲突时提示重读而不是重试。
- **令牌泄露**：`accessToken` 是 secret 类字段，回读视图会给掩码。面板不能把掩码当成真实值再写回去。
- **跟随默认的语义**：选"跟随默认"时不能把当前默认值抄进配置，否则默认变了它不跟着变。
- **未连上时的场所列表**：驱动没连上时读到的是人工填的清单，连上后要能对账，不能静默覆盖人工填的内容。

## File Structure

| 文件 | 责任 |
|---|---|
| `packages/driver-onebot11/src/transport.ts` | 两种连接方向共用一个 `Transport` 接口；`ReverseWs` 已有，新增 `ForwardWs` |
| `packages/driver-onebot11/src/config.ts` | 驱动的 `Config` schema（volatile），字段：`mode`/`url`/`host`/`port`/`accessToken`/`platform` |
| `packages/driver-onebot11/src/index.ts` | 按 `mode` 选传输；空配置时给出可读的报错 |
| `packages/channel/client/client.js` | 浏览器模块：注册 `settings.section`，三个分区（连接 / 模型 / 场所） |
| `packages/channel/locale/{zh,en}.json` | 面板文案 |
| `packages/channel/package.json` | `dsh.client` + `./client` 导出 |

## Task 1：驱动支持正向连接

**Files:** `packages/driver-onebot11/src/transport.ts`、`packages/driver-onebot11/tests/transport.spec.ts`

**Interfaces**（照现有 `ReverseWs` 的形状统一，计划初稿里的 `send(ChannelAction)` / `forwardWs(...)` 工厂作废——仓库没有 `ChannelAction`，事件已是解析后的对象，两种形状并存会打架）：

```ts
export interface Transport { onEvent(next): void; start(): Promise<void>; stop(): Promise<void>; call(action: string, params: Record<string, unknown>): Promise<unknown>; readonly connected: boolean }
export interface ForwardWsOptions { url: string; accessToken?: string; reconnectMs?: number }
export class ForwardWs implements Transport { constructor(options: ForwardWsOptions) }
```

- [ ] 写失败测试：起一个本地 `ws` 服务充当 NapCat，`forwardWs` 连上后推一条报文，断言 `onEvent` 收到；服务端 `close()` 后断言重连（间隔 ≥1s，至少重试一次）。
- [ ] 跑 `npx vitest run packages/driver-onebot11/tests/transport.spec.ts` 确认失败。
- [ ] 实现 `forwardWs`：连接时带 `Authorization: Bearer`；`echo` 关联沿用现有逻辑；断开后按固定间隔重连，`stop()` 后不再重连。
- [ ] 测试转绿；`pnpm test` 全绿。
- [ ] 提交：`feat(driver-onebot11): 正向 WebSocket 传输`。

## Task 2：驱动声明 Config 并按方向建传输

**Files:** `packages/driver-onebot11/src/config.ts`（新）、`src/index.ts`、`tests/driver.spec.ts`（新；「按 mode 选传输」不是协议换算，不塞进 protocol.spec.ts）

**Interfaces:**
```ts
export const Config = z.object({
  platform: z.string().default('qq'),
  mode: z.union([z.const('reverse'), z.const('forward')]).default('reverse').volatile(),
  url: z.string().volatile(),
  host: z.string().default('0.0.0.0').volatile(),
  port: z.natural().default(6700).volatile(),
  accessToken: z.string().role('secret').volatile(),
})
```

- [ ] 写失败测试：`mode==='forward'` 且缺 `url` 时抛出的错误里含 `url`；`mode==='reverse'` 时不读 `url`。
- [ ] 实现 `Config`，`apply` 里按 `config.mode` 选 `forwardWs` 或 `reverseWs`。
- [ ] 测试转绿；提交：`feat(driver-onebot11): 声明 Config，支持正反两种连接方向`。

## Task 3：客户端骨架，能让设置页出现"时煦"分区

**Files:** `packages/channel/client/client.js`（新）、`locale/zh.json`、`locale/en.json`、`package.json`

- [ ] `package.json` 增 `dsh.client = { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings'] }` 与 `"./client"` 导出；`files` 加 `client`、`locale`。
- [ ] 写 `client.js`：`window.__ModuleLoader__.load({ id: 'dsh-shixu-channel', factory })`，`inject = ['slots', 'remote', 'remote.settings']`，`apply` 里 `ctx.slots.inject('settings.section', …register({ name:'settings.section', id:'shixu', order: 40, label }))`，内容先渲染一行版本号。
- [ ] 打包安装到 dev 实例，打开设置页，确认出现"时煦"分区且控制台无报错。
- [ ] 提交：`feat(channel): 设置页分区骨架`。

## Task 4：读配置（describe + 命名空间定位）

**Files:** `packages/channel/client/client.js`

- [ ] 在 dev 实例的面板里打印 `ctx.remote.settings.describe()` 的返回，**把真实形状抄进本任务下方**，确认哪个命名空间对应我们这一行、字段怎么取。
- [ ] 实现读取：拿到 `{ revision, values }`，渲染成"当前值"三组；读失败时显示错误而不是空表单。
- [ ] 验证：在 profile patch 里手改一个字段，刷新页面后面板显示新值。
- [ ] 提交：`feat(channel): 面板读取当前配置`。

## Task 5：写配置（带 revision 的保存）

**Files:** `packages/channel/client/client.js`

- [ ] 实现脏状态：改动只存在组件里，点"保存"才提交；保存中禁用按钮。
- [ ] 写回带 `expectedRevision`；收到冲突错误时**不重试**，提示"配置已被别处改动，重新读取"。
- [ ] `accessToken` 的处理：读到的掩码与用户没改过时，提交里不包含这个字段（不把掩码写回去）。
- [ ] 验证：改端口 → 保存 → 重启容器 → 驱动按新端口监听。
- [ ] 提交：`feat(channel): 面板保存配置（带冲突检测与密钥保护）`。

## Task 6：场所分区

**Files:** `packages/channel/client/client.js`

- [ ] 代码里不出现任何具体群号；表格可增删行，列为「群号 / 角色 / 启用」。
- [ ] 驱动连上后能回显"当前在线的群"；与人工清单不一致时显示差异提示，**不自动合并**。
- [ ] 提交：`feat(channel): 面板管理场所列表`。

## Task 7：分发验证

- [ ] `pnpm pack` 两个包，装进一个全新的 profile（不继承开发实例的状态），确认：设置页出现分区、表单为空但可填、填完能保存、重启后仍生效。
- [ ] `README` 增一段：装好之后去哪配置，一句话，不贴截图。
- [ ] `python scripts/check_docs.py` 通过；提交：`docs: 说明配置入口`。

## 未决（执行时必须先问）

- Task 4 的 `describe()` 真实形状没有回读过安装包的运行时输出，只有类型文件里的 `{ base, user, applies, secrets, revision }` 迹象。**Task 4 第一步就是把真实输出抄下来**，形状对不上就停下来说明，不要猜着往下写。
