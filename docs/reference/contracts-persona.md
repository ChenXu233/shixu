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
├── personality.md      我是谁：身份、性格（重建会话或重启进程时读取）
├── behavior.md         什么时候说话：怎么观察局面、什么时候安静
├── reply_style.md      怎么说话：长短、语气、习惯
├── examples.md         举例：「别人说 → 它回」，风格最强的锚
├── persona.md          这些都没有时的回落：整段当「我是谁」
├── identity.json       主人名单：{"owners": ["平台用户 id"]}；没有它就是没有跨场所的主人
├── core.md             手写记忆：关于它自己和主人（人编辑，直接进提示）
├── memory/memory.db    记忆库（SQLite，全局一份）：messages / facts / paragraphs / entities / relations / profiles + FTS5 全文索引
├── memory/md/          记忆的正文（git 可读可 diff）：facts.md、people/<名字>.md、venues/<场所>.md
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
    ├── scratch/        该场所的临时产物
    └── artifacts/      归档的成品
```

**所有场所共用一个 cwd**：人格根，不是 `venues/<venueId>/scratch`（理由见 [ADR-0010](../adr/0010-persona-config.md)）。工作区按 cwd 归组，所以一个部署的人格在侧栏里只占一个项目。

注册为真正的 DSH 项目：

```ts
const dir = personaDir(personaId)                 // 目录必须先存在
const project = await ctx.workspaceRegistry.create(dir, '时煦-' + persona.name)   // 侧栏里显示的名字
const session = ctx.sessions.create(sessionId, { meta: { cwd: dir } })   // 自动归组
```

会话第一次落盘必须走 `ctx.agents.create` —— `resume` 没有 cwd 参数，见 [DSH 接缝](../reference/dsh-seams.md#可用的seam精确到-api)。

依赖挂载：`dsh-session` + `dsh-session-persistence-jsonl` + `dsh-storage` + `dsh-storage-json` + `dsh-storage-domain` + `dsh-workspace`。

## 配置面

落盘位置是 profile patch 里 binding 那一行的 `config`，形状由插件导出的 `Config` 决定（依据 [ADR-0010](../adr/0010-persona-config.md)）：

```yaml
personaId: default          # 它是谁，同时是数据目录名
provider: openrouter        # 省略 = 跟随部署默认
model: deepseek-v4.1-flash-oc
reasoningEffort: max
mutedVenues:                # 例外：让它安静的场所
  - 'qq:1658856973:791465037'
```

| 形状 | 形态 | 例子 |
|---|---|---|
| 标量 | 原生表单字段 | `provider`、`model` |
| 例外清单 | 一组字符串，可增删 | `mutedVenues` |
| 运行事实 | 只读 | 在线场所、连接状态 |
| 派生事实 | 不出现 | cwd、sessionId |

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

## 提示词里有什么

每次投递前按顺序拼三段，顺序即 `order`：

| 段 | order | 内容 |
|---|---|---|
| `shixu:persona` | 10 | 人格文本（personality / behavior / reply_style / examples），没写就整段消失 |
| `shixu:venue` | 15 | 它在哪个会话里、**直接说话就是回复**、三个出站工具各管什么、调用要带 `principal`、不要用括号写旁白 |
| `shixu:core` | 20 | `core.md` 手写记忆 |

`shixu:venue` 是引擎给的，不写进人格：它解释的是「这一轮怎么运作」，人格文件解释的是「它是谁」。

## 记忆分层与可见性

| 层 | 内容 | 可见范围 |
|---|---|---|
| core | 自我事实：我是谁、我在忙什么、我的习惯 | 所有场所 |
| public | 可对外说的话（主人授权过的偏好等） | 所有场所 |
| private | 私聊里学到的 | 默认仅私聊场所 |
| venue/<id> | 该场所的事实 | 仅该场所 |

写路径唯一：所有写入经记忆服务，见[判据与默认值](policies.md#红线)。同步语义见[跨场所记忆](../explanation/memory.md)。

## 身份与权限

两件事，两个类型，没有第三个。

```ts
/** 出厂角色只是种子；用户可以加自己的（'vip'、'运营'、'客户'…）、改名、删掉不用的。 */
export type BuiltinRole = 'owner' | 'trusted' | 'guest' | 'autonomous'
export type Role = string

/** 一个回合的发起者。三个字段，别的不要。 */
export interface TurnActor {
  subject: string   // 平台用户 id；身份表的键
  role: Role        // 查出来的角色，本回合内固定；查不到 = 默认角色
  venueId: string   // 防跨场所冒用：A 群的身份不能在 B 群用
}

/** 一条规则：这个角色对这个工具名给一个决定。match 支持 `*` 通配。 */
export interface PermissionRule {
  match: string     // '{platform}_{action}' · 'mcp__<serverName>__*' · '*'
  decision: 'allow' | 'ask' | 'deny'
}

export type PermissionMatrix = Record<Role, PermissionRule[]>
```

**角色只有一个来源：主人自己写的信任表**（`identity.json` 的 `owners` / `trusted`，其余一律 `guest`）。平台报的角色（群主、管理员）**不参与判定** —— 群主管得着那个群，管不着这台机器，而且主人根本不认识所有群的群主。理由见 [ADR-0011](../adr/0011-trust-table-is-the-only-authority.md)。

判定三步：

1. **从后往前**，第一条命中的规则胜出（后面的覆盖前面的）；
2. 一条都没命中 → 工具的原生默认（`risk` 的映射，见[判据与默认值](policies.md#风险只提供默认值)）；
3. 原生默认也没有（门 B 的工具）→ `deny`。

**每次调用都要声明替谁做**：动作目录生成的工具多一个必填参数 `principal`（说话人的用户 id，或 `self` 表示它自己决定）。声明的人必须是**这一轮里真的开过口的人**；对不上就拒绝 —— 模型不能替一个没开口的人做主。

**一轮里可能有好几个发起人。** 这一轮还在跑的时候来的消息是**插进它的下一步**（`inject`），不是排队等下一轮 —— 所以同一轮里会出现两个不同的人。这时候「替谁做」不能猜，模型必须自己声明；不声明就拒绝，话术是「这一轮有多个说话人（…），请用 principal 声明这条是为谁做的」。注入不触发 `user/message`，说话人由内核在注入时记进本轮名单。

**拒绝给的是技术文本，不给语气。** `拒绝：tool=qq_mute principal=1964324406 name=小明 role=guest 原因=角色不允许` —— 工具名、发起人、昵称、角色、原因；没有第一人称、没有劝告、没有替人设决定的措辞。昵称跟着账号一起给，模型不必自己去对「这个号是谁」。

怎么把这件事说出口，写在 `persona.md` 里。引擎不注入任何「拒绝时该怎么说」的守则：写死的措辞改不了，而且会带着引擎自己的口吻。

**没有 `decide()` 这个函数。** 它要做的事就是 `tools/pre-execute` 这个钩子要做的事，而那个钩子的返回值本来就是 `allow` / `ask` / `deny`。多起一个名字，就多一份要同步的语义 —— 判定写在监听里，规则表是配置，仅此两样。

**身份里没有签名、没有 `epoch`、没有 `scopes`。** 进程内没有对手：能改这三个字段的代码，本来也能改任何东西。签名等跨进程的线缆协议出现再加（[待拍板](../adr/README.md#待拍板)第 1 项），那才是它第一次有意义的时候。

### 角色是用户可扩展的

内置角色只是种子。用户可以加新角色、改名字、删掉不用的 —— 但**落点只有一个**：身份表里查不到的 subject 一律落进**默认角色**（出厂叫 `guest`）。这个落点删不掉，权限也不能被配成更高，它是[红线 4](policies.md#红线)的载体。

规则表**第一行写兜底**（`{ match: '*', decision: 'deny' }`），后面逐条放开 —— 判定从后往前，所以读起来就是执行顺序。

角色之间**不做继承**。继承会把「取最后一条」变成算一条链，链上任何一处配错都是静默放大权限；平铺的规则列表，出问题只看一行。`autonomous` 是其中一个普通角色 —— 定时、做梦、主动发言这些回合没有发起人，不借用任何人的角色。

`action.name` 对门 B 的工具是 `mcp__<serverName>__<tool>`。矩阵里可以按 server 前缀授权（`mcp__calendar__*`）—— 我们本来就不认识单个工具，按 server 授才是诚实的粒度。

模型看不到这三个字段，也不需要看到 —— 它只看到「当前对话者的角色」这样的提示文本；**执行判定只读服务端状态，不读对话内容**。

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
