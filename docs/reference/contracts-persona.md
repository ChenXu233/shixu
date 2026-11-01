# 人格引擎契约（L3）

> **状态**：已决议（P0 待冻结为类型包）
> **日期**：2026-10-31
> **读者**：写 `dsh-shixu-persona` 的人
> **上游材料**：[分层与 bundle 形态](layering.md)、[渠道内核契约](contracts-channel.md)
> **口径**：字段与语义冻结；为什么这样设计见 `../explanation/` 下对应文档

本页是 L3 的类型、目录与界面契约。判据与阈值见[判据与默认值](policies.md)。

## 人格工作区布局

```text
$DSH_HOME/persona/<personaId>/
├── persona.md          人设 / 性格 / 说话风格（可热重载）
├── memory/
│   ├── core.json       自我事实（我是谁、我在忙什么）
│   ├── public.json     可对外说的话
│   ├── private.json    私聊里学到的（默认仅私聊场所可见）
│   └── venues/<venueId>.json   该场所自己的事实
├── venues/<venueId>/
│   └── state.json      场所状态、在场时间、预算、统计
└── journal/            离场日志（我为什么切走、我想干什么）
```

沙箱下的产物目录（与上面同一棵树）：

```text
~/.dsh/persona/<personaId>/
├── workspace/          人格公共产物（跨场所可见）
└── venues/<venueId>/
    ├── scratch/        该场所的临时产物（场所 agent 的 cwd）
    └── artifacts/      归档的成品
```

注册为真正的 DSH 项目：

```ts
const dir = personaDir(personaId)                 // 目录必须先存在
const project = await ctx.workspaceRegistry.create(dir, '人格 · ' + persona.name)
const session = ctx.sessions.create(sessionId, { meta: { cwd: dir } })   // 自动归组
```

依赖挂载：`dsh-session` + `dsh-session-persistence-jsonl` + `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain` + `dsh-workspace`。

## 在场集合

```ts
interface PersonaPresence {
  personaId: string
  open: Map<VenueId, VenuePresence>   // 当前「挂着」的场所集合（可多个）
  attention: { cap: number; used: number }   // 同时在场数上限
  rate: { window: number; limit: number }    // 跨场所总发言速率
}

interface VenuePresence {
  venueId: VenueId
  sessionId: SessionId
  agentId: string
  openedAt: number
  lastActivityAt: number
  lastReplyAt: number
  pending: number               // 未处理消息数
  visit: { replies: number; dwellMs: number; capReplies: number; capDwellMs: number }
  state: 'open' | 'quiet'       // open = 还在挂着；quiet = 挂着但已冷清
  dampUntil: number             // 最小重入间隔（不是封锁）
}
```

场所生命周期只有三个状态，转移规则见[人格与场所](../explanation/persona-presence.md#场所生命周期)。

## 记忆分层与可见性

| 层 | 内容 | 可见范围 |
|---|---|---|
| core | 自我事实：我是谁、我在忙什么、我的习惯 | 所有场所 |
| public | 可对外说的话（主人授权过的偏好等） | 所有场所 |
| private | 私聊里学到的 | 默认仅私聊场所 |
| venue/<id> | 该场所的事实 | 仅该场所 |

写路径唯一：所有写入经记忆服务，见[判据与默认值](policies.md#红线)。同步语义见[跨场所记忆](../explanation/memory.md)。

## capability token

```ts
export type CapabilityScope =
  | 'chat'            // 允许普通对话
  | 'tools'           // 允许触发哪些平台动作（按动作名细分）
  | 'files'           // 允许在沙箱里写文件 / 跑命令
  | 'publish'         // 允许发布站点
  | 'admin'           // 允许改人设 / 预算 / 白名单
  | 'memory:public'   // 允许写入公开层记忆
  | 'memory:core'     // 允许写入自我层记忆

export interface CapabilityToken {
  readonly subject: string      // 平台用户 id（如 qq uin / discord id）
  readonly role: 'owner' | 'trusted' | 'member' | 'guest'
  readonly scopes: ReadonlySet<CapabilityScope>
  readonly venueId: string
  readonly epoch: number         // 人格权限版本，改权限即失效旧 token
  readonly issuedAt: number
  readonly expiresAt: number
  readonly mac: string           // HMAC(secret, 上述字段)，secret 存 ctx.credentials
}
```

判定不是布尔：`ask` 是一等结果（它落到审批闸门）。词表与 DSH 的 `tools/pre-execute` 同构，映射是恒等。

```ts
export type Decision = 'allow' | 'ask' | 'deny'

/** 一条授权规则。match 支持 `*` 通配：'{platform}_{action}' · 'mcp__<serverName>__*' · '*' */
export interface PermissionRule {
  match: string
  decision: Decision
}

/** 触发者角色 + 自主回合。自主回合没有发起人（定时、做梦、主动发言），单列一格。 */
export type ActorRole = CapabilityToken['role'] | 'autonomous'

/** 角色 → 规则。用户可改；改了就递增 epoch，让旧 token 全废。 */
export type PermissionMatrix = Record<ActorRole, PermissionRule[]>

export function decide(
  token: CapabilityToken,
  action: { scope: CapabilityScope; name?: string },
  native?: Decision,                                          // 工具的原生默认；门 B 没有
): Decision
```

四步，缺一步都算未授权：

1. token 校验失败（过期 / `epoch` 不符 / `scope` 不覆盖 / 验签不过）→ `deny`；
2. 命中的规则取最严（`deny` > `ask` > `allow`）；
3. 没命中 → `native`；
4. `native` 也没有 → `deny`。

规则顺序与出厂值见[判据与默认值](policies.md#风险只提供默认值)。

`action.name` 对门 B 的工具是 `mcp__<serverName>__<tool>`。矩阵里可以按 server 前缀授权（`mcp__calendar__*`）—— 我们本来就不认识单个工具，按 server 授才是诚实的粒度。

模型看不到 token，也不需要看到 —— 它只看到「当前对话者的角色」这样的提示文本；**执行判定一律走验签后的 token**。

## 动作凭据

每个对外动作留一张凭据，控制的是一键回滚，不是「再执行一次相反操作」。

```ts
export interface ActionReceipt {
  id: string
  venueId: string
  actor: 'autonomous' | { subject: string; role: string }   // 谁触发的
  action: string                                            // 'ban' | 'publish' | 'send' | ...
  params: Record<string, unknown>
  reversible: boolean
  undo?: { kind: 'unban' | 'unpublish' | 'delete_message' | 'restore' | 'unreact'; payload: unknown }
  snapshot?: unknown        // 执行前的状态：被封成员 id、原发布 URL、原消息 id
  at: number
}
```

## 发布器

```ts
export interface Publisher {
  id: 'local' | 'cloudflare-tunnel' | 'reverse-proxy' | 'tailscale-funnel'
  publish(site: PublishedSite): Promise<{ url: string; revoke(): Promise<void> }>
}

export interface PublishedSite {
  slug: string       // 白名单 [a-z0-9-]{1,40}，服务端强制
  root: string       // 必须位于 publish root 之内
  visibility: 'private' | 'token' | 'public'
}
```

发布流程与安全清单见[沙箱与产物交付](../explanation/sandbox-delivery.md)和[判据与默认值](policies.md#发布安全清单)。

## 人格控制台

**设置页**：账号与渠道、凭据（落 `ctx.credentials`，不回显）、白名单与访问模式、persona pack 编辑、预算参数。

**人格控制台**（独立面板）：

| 区块 | 内容 |
|---|---|
| 在场列表 | 每个群 / 私聊一行 → 状态（open / quiet / closed）、pending、已用预算、damp 倒计时 |
| 注意力面板 | 当前挂着哪几个场所、各自待办、这一轮在看谁 |
| 全局预算 | 同时在场数 / 已用、跨场所速率 / 上限、fairness 插队记录 |
| 真实回复流 | 选中场所 → 读该场所 DSH session 日志 → 展示 agent 实际产出（含发到 QQ 的原文） |
| 干预 | 立刻切到某场所、叫回（结束占用）、强制收起某场所、暂停整个人格 |
