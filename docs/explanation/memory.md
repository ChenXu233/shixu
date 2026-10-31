# 跨场所记忆：一个脑子，多个房间

> **状态**：已决议
> **日期**：2026-10-31
> **读者**：写人格引擎记忆服务的人
> **上游材料**：[人格引擎契约](../reference/contracts-persona.md#记忆分层与可见性)、[判据与默认值](../reference/policies.md#记忆提交策略)
> **口径**：讲机制与已知限制；层定义见契约页，提交与公开策略见判据页

## 为什么不能靠「共享同一个 session」

先排除掉最容易想到的方案 —— 所有人格共用一个 session，记忆天然共享。四个问题：

| 维度 | 单一 session | 每场所一个 session（采用） |
|---|---|---|
| 记忆共享 | 天然共享 | 靠共享记忆服务 + 组装期读穿实现 |
| 隐私 | **致命**：私聊内容会进群上下文 | 按可见性分层，互不越界 |
| 上下文 | 被所有群的刷屏撑爆 | 每个场所只看自己的对话 |
| 工具隔离 | `agent.ctx` 是 agent 级，无法按场所裁剪 | 每个场所 agent 独立 shadow tools |

所以：**一个场所 = 一个 session + 一个 agent；人格的公共部分通过共享记忆服务注入，而不是通过共享会话历史**。

## 记忆服务：所有写入的唯一入口

权威存储是 `ctx.storageDomain`（插件自有持久数据），同时镜像成 JSONL 供人阅读。

写：模型显式决定「记什么」，服务端强制可见性规则 ——

```ts
ctx.tools.register(defineTool({
  name: 'persona_remember',
  description: '记住一件事。scope 决定谁能听到：core=只有自己知道，public=可以对任何人说，private=仅私聊，venue=仅某个场所。',
  parameters: {
    scope: { type: 'string', required: true },
    fact: { type: 'string', required: true },
    venueId: { type: 'string', required: false },
  },
  output: { schema: { type: 'object' }, render: (a, v) => [{ type: 'text', text: '记住了' }] },
  async execute(args) {
    // 转授权在服务端拦截，不能靠提示词自觉
    if (args.scope === 'public' && !ownerAuthorized(args)) {
      throw new Error('把私聊内容转述到公开层需要主人授权')
    }
    return memory.append({ scope: args.scope, fact: args.fact, sourceVenue: venueOf(args) })
  },
}))
```

读：注册在「每个场所 agent」的 `ctx` 上，**组装期求值** ——

```ts
// 静态人格底稿（所有场所一致）
agent.ctx.systemPrompt.section({ name: 'persona.core', order: 10, text: personaMd })

// 动态上下文：每次请求组装时重新求值 → 每次新消息都是最新切片
agent.ctx.systemPrompt.context({
  name: 'persona.memory',
  order: 900,                       // 放尾部：变动只让前缀缓存的尾部失效
  text: () => {
    const slice = memory.sliceFor(venueId)      // core + public + venue:<id>（+ private 若授权）
    const state = presenceStateFor(venueId)      // 我还挂在哪几个群、各自待办、最近跨场所事件
    return renderMemoryBlock(slice, state)
  },
})
```

关键点：**context 的 text 是 `(AssembleContext) => string`，每次请求组装时求值**（官方：Dynamic prompt context「a provider evaluated at each assembly」）。所以场所 agent 每开一轮新对话，拿到的都是当下的共享记忆；不需要重建 agent，也不需要手动刷新。

## 同步语义

明确写死，避免含糊：

| 维度 | 语义 |
|---|---|
| 可见性边界 | 按 scope 过滤：core / public 全可见；private 默认仅私聊场所；venue/<id> 仅该场所 |
| 同步时点 | **跨场所可见性以「对方下一轮组装」为界**：A 群这一轮结束写入后，B 群下一次发言就能看到。不做中途打断 |
| 一致性 | 写路径唯一，append-only + 单调 seq；事实按 key 版本化，新版 supersede 旧版但保留历史 → 跨场所并发写不会互相覆盖丢数据 |
| 读己之写 | 写入方自己立刻可见（同 store，下一次组装即生效） |
| 跨场所延迟 | 天然存在且刻意保留 —— 人也不会知道隔壁房间刚发生了什么，除非被告知 |
| 连续感来源 | 三块注入：① 人格底稿（静态一致）② 共享记忆切片（动态、按可见性）③ 在场状态块（我还挂在哪几个群、各自待办、最近跨场所事件尾部） |

## 广播：延迟投递，不打断正在进行的思考

跨场所更新要能互相看见，但不打断对方正在跑的回合。DSH 的 inbox 语义正好提供这个：

- `followup()` → 排下一轮普通 prompt，并唤醒 driver
- `steer()` → **提交下一步输入**，在下一个 step 边界进入
- `inject()` → 加模型可见上下文，**不唤醒** driver，落在下一个被接纳的 step
- inbox 是耐久的，有两个待处理列表 `{ next-turn, next-step }`；「Claiming removes offered messages from the inbox, while messages inserted after the claim remain pending for a later boundary」

所以广播策略：

```ts
// 广播事件：记忆写入 / 场所切换 / 产物产出 / 主人指令
for (const venue of persona.presentVenues()) {
  if (venue.agentRunning) {
    venue.handle.steer({                        // 下一个 step 边界进入，不打断当前思考
      content: [{ type: 'text', text: digest(event) }],
      source: { kind: 'persona-broadcast' },
    })
  }
  // 空闲的场所什么都不做：它下次组装时，读穿机制自然带上最新记忆
}
```

| 维度 | 规则 |
|---|---|
| 不打断 | 运行中的场所用 `steer()`，内容在下一个 step 边界进入，当前模型调用不受影响 |
| 空闲场所零成本 | 不发消息；它下次开口时，读穿机制已经把最新记忆带进去了 |
| 噪音控制 | 只有 public / core 级记忆、场所进出、产物产出才广播；private 不广播 |
| 合并 | 短时间多条广播合并成一条摘要（避免连续 steer 把模型刷醒） |
| 背压 | 单场所待处理广播上限，超限合并或丢弃最旧 |
| 另一个钩子 | `agent/turn-stopping` 可在回合即将结束时 steer 保持回合继续 —— 适合「我刚想到还有件事」 |

> 关键洞察：**空闲场所的广播是免费的**（读穿机制覆盖），只有运行中的场所才需要显式 steer。这让广播的实现成本极低，也避免了打断。

## 已知限制

不掩饰：

- **DSH 无原生 agent 间共享状态**：记忆服务是我们自建的，引擎单点持有。
- **动态 context 在一次 assembly 内不重跑**：长回合（多步工具调用）中途记忆不会刷新，只有新一轮对话才更新。可接受。
- **KV 缓存代价**：记忆切片是易变内容，会让前缀缓存从变动处失效。把易变块放在提示词尾部（order 900）可把失效范围压到最小。
- **写入是模型发起的**：模型可能不记、记错、记太细。记忆服务要提供可审阅的控制台（人工增删改）与「记忆质量」提示（让人格定期自省记忆内容）。

## 记忆是 git 仓库

记忆从「一块可变状态」变成「一条有时间轴的资产」：

- **可回溯**：出问题时能看它当时到底记得什么 —— 这是调试拟人行为的唯一手段；
- **可审计**：记忆被谁改了、什么时候改的，diff 一目了然 → **prompt injection 留下的痕迹会被看见**；
- **可回滚**：被污染了就退回去；
- **可 fork / 可分享**：人格包带着记忆一起分发；
- **可同步**：Git 天然是多设备 / 多实例的同步源。

人格工作区本身就是一个 git 仓库：

```text
~/.dsh/persona/<personaId>/          ← git repo（也是场所 session 的 cwd）
├── persona.md
├── memory/
│   ├── core/          自我事实（push）
│   ├── public/        可对外说的（push）
│   ├── private/       私聊里学到的（公开策略见决策登记）
│   └── venues/<id>/   各场所自己的事实（push）
├── sites/             已发布站点
└── journal/           梦境日记，每天一份
```

DSH 侧的 git 能力边界（实测）：DSH 没有独立的 git 服务，git 是通过 subprocess 调 git 可执行文件实现的 —— `dsh-workspace-changes` 的官方描述是「requires the `subprocess` and `fs` services」+「a git executable on the Host」。用 `ctx.shell` 即可，沙箱 workspace-write 允许写 workspace root（含 `.git`）。

顺带复用：`dsh-workspace-changes` 已经为每个回合算 git 工作区的 turn-start / turn-end 差异并发 `workspace/changes` 事件 → 「这一回合人格改了哪些记忆」几乎现成。提交时机见[记忆提交策略](../reference/policies.md#记忆提交策略)。

## 夜间做梦

- 触发：`ctx.schedule` cron（默认每天 23:30），主人可改；
- 执行：新建一个**独立的梦境 session**（cwd = 人格工作区）→ 一个不占用任何场所的 agent 跑一轮；
- 梦境能力集：读全部记忆 + 读当天各场所日志 + 写 core / public / venue + commit。**不能** publish / admin / 花钱；
- 做什么（对齐 `dsh-roost` 已有的「凌晨巩固」：打分、升降级、到期压缩、抽三元组、提取约定）：
  - **巩固**：零散事实合并成更一般的结论；
  - **衰减**：久未提及的记忆降权或归档；
  - **提炼**：抽出约定、偏好、待办；
  - 「做梦」只是「离线批量整理」的人话说法；
- 产出：更新 `memory/` + 写 `journal/YYYY-MM-DD.md` + commit（+ 可选 push）；
- **可观测**：控制台里能看到「昨晚它梦了什么」—— 人格有日记，这很有人味。

## 时间旅行与分叉

- **回到某个 commit 的记忆**：owner-only 命令（走 `ctx.commands`，不经模型）——「让它回到上周三的样子」；
- **fork 出新的人格**：从某个 commit 开一个新分支 → 新 persona 目录 + 新身份表 → 一个「平行世界的自己」；
- **人格包分发**：人格 + 人设 + 记忆历史一起打包，别人装上就是个有过去的人。

## 上传到 GitHub

| 项 | 规则 |
|---|---|
| 凭据 | GitHub token 存 `ctx.credentials`（密钥空间），**绝不进仓库、绝不进提示词** |
| 仓库 | 默认私有；是否公开、公开时是否包含 private 记忆，由开发者自己决定 |
| 时机 | 每次梦境 commit 后 push（可关）；或只在主人手动触发时 push |
| 推送前扫描 | 复用 `persona_deploy` 的凭据扫描逻辑，命中就中止 push |
| 多设备 | Git 可作同步源，但记忆并发写会冲突 → **单机权威 + 其它设备只读镜像** |
