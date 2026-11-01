# 渠道内核契约（L1 / L2）

> **状态**：已决议（P0 待冻结为类型包）
> **日期**：2026-10-31
> **读者**：写 `dsh-shixu-channel` 与 `dsh-shixu-driver-*` 的人
> **上游材料**：[分层与 bundle 形态](layering.md)、[DSH 接缝与硬约束](dsh-seams.md)
> **口径**：字段与语义冻结；类型名可调，语义不可调

本页是 L1 / L2 的类型与行为契约。为什么这样设计见[渠道内核：为什么长这样](../explanation/channel-core.md)。

## 统一事件模型

取 OneBot 12 的 `self` 语义：账号是 `(platform, accountId)` 二元组，不是一个裸 id。

```ts
export type EventType = 'message' | 'notice' | 'request' | 'meta'
export type DetailType = 'private' | 'group' | 'guild' | 'channel' | 'friend' | 'system'

/** 平台 + 账号 二元组。NoneBot2 用裸 self_id 建全局池，跨平台同号会撞 —— 我们不这么做。 */
export interface SelfRef { platform: string; accountId: string; displayName?: string }

export interface UnifiedEvent {
  id: string                 // 平台内唯一 + 前缀，用于去重（OB12 事件必有 id）
  type: EventType
  detailType: DetailType
  subType?: string
  self: SelfRef
  timestamp: number          // epoch ms
  conversationId?: string
  userId?: string
  senderName?: string         // 发言人的显示名（群名片优先）——只给 id 的话人格叫不出人名
  messageId?: string
  message?: MessageSegment[]
  text?: string
  raw: unknown               // 平台原始载荷，逃生舱，永不丢弃
}
```

`protocol` 不在事件里：它是驱动的身份，由内核在扇出时盖上。驱动写不出来，也就骗不了路由。

**消息段是扁平的**，不做 Koishi 那套树形 `h()`：

```ts
/** 扁平 canonical + native 透传（双轨）。不用 Koishi 树形 h()：DSH 会话日志是扁平 JSON，
 *  树形元素的跨平台降级路径爆炸，复杂结构一律走 native 透传。 */
export interface MessageSegment {
  type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'mention'
      | 'mentionAll' | 'quote' | 'card' | 'markdown' | 'node' | 'json' | string
  data: Record<string, unknown>
  native?: unknown
}
```

## 能力声明

两家框架都缺这一层，而它是「自动降级」与「工具能否调用」的唯一依据。

```ts
export interface Capabilities {
  sendImage: boolean; sendAudio: boolean; sendVideo: boolean; sendFile: boolean
  sendCard: boolean; sendMarkdown: boolean; sendQuote: boolean
  sendMention: boolean; sendMentionAll: boolean
  revokeMessage: boolean; editMessage: boolean; fetchHistory: boolean
  uploadFile: boolean; addFriend: boolean; approveRequest: boolean
  kickMember: boolean; muteMember: boolean; setMemberRole: boolean
  maxMessageLength: number; maxMediaSize: number
  passiveReplyOnly: boolean     // 仅被动回复的平台
}
```

## ActionDescriptor 与 ChannelDriver

```ts
export interface ActionDescriptor {
  name: string               // 'like' → 工具名 discord_like
  description: string        // 给模型看：用途 + 代价 + 前置条件
  parameters: JsonSchema     // 模型可填参数；注意不需要 bot_id
  risk: 'read' | 'write' | 'destructive'
  needsApproval: boolean
  scope: 'chat' | 'account' | 'guild'
}

export interface ChannelDriver {
  protocol: string            // 'onebot11' | 'onebot12' | 'satori' | 'native:discord'
  label: string
  profile: ChannelProfile     // 渠道人格与忌讳
  actions: ActionDescriptor[] // 门 A：动作目录
  capabilities: Capabilities
  connect(acct: AccountConfig, ctx: DriverCtx): Promise<void>
  disconnect(): Promise<void>
  call(action: string, params: unknown, ctx: CallCtx): Promise<unknown>
  onEvent(h: (ev: RawEvent) => void): void
}

// 注册表键是 protocol，不是 platform：同一个 QQ 可以同时挂 OneBot 11 与官方 API。
// 'send' 是内核的出站路径，不走动作目录 —— 人格的回复经它出去，模型调不到它。
```

**1 chat = 1 session = 1 agent ⇒ 工具注册在 `agent.ctx` 上**，由此得到四条：

- 模型看到的工具集 = 当前聊天所在渠道的动作，不串味；
- 模型参数里不需要 `bot_id`（NoneBot 的 `call_api` 必须显式传 `bot_id` + api 名，因为它是全局工具池）；
- 平台动作天然继承该 agent 的账号身份与权限；
- 工具集稳定 → prompt 前缀稳定 → 前缀缓存不失效（可见工具集或顺序一变，缓存即废）。

**命名**：`{platform}_{action}`，例 `discord_like`、`qq_group_ban`、`telegram_pin`。多账号同平台不加后缀（作用域已隔离）。

`risk` 字段的默认处置见[判据与默认值](policies.md#动作风险与默认处置)。

## 两条能力通道

能力有两条门，都是原始设计（[ADR-0006](../adr/0006-capability-two-doors.md)）：

| 门 | 声明处 | 工具名 | 内核拿它做什么 |
|---|---|---|---|
| A 已抽象 | `actions: ActionDescriptor[]` | `{platform}_{action}` | 查角色规则；没命中就用 `risk` 换来的原生默认 |
| B 未抽象 | 驱动自带的 MCP server，**契约里不出现** | `mcp__<serverName>__<tool>` | 查同一套角色规则；**不判风险**、不分级、不施闸 |

选哪条门是驱动作者的判断。**内核不判断「这个平台该有哪些能力」** —— 一旦它开始维护平台能力清单，抽象就又回到了「把差异全建模」的老路。

门 B 不带任何分级、豁免或白名单：能写出风险等级的，就已经抽象完了，那它该进动作目录。它剩下的只有授权 —— 而授权不需要知道工具做什么，只需要知道说话的是谁，所以走的是与门 A 同一套 [角色矩阵](contracts-persona.md#身份与权限)：按工具名匹配 `mcp__<serverName>__*` 或单个工具名。**未识别者默认拒绝。**

执行时能跑多远是另一回事，归宿主：沙箱模式与审批策略捆成的权限档位（仅工作区 / 完全权限）。**挂载只是资源决定，不是授权** —— 它决定这个场所要不要为一条 MCP 连接付成本。

**未抽象不是降级。** 降级是同一个能力在弱平台上表达退化（图片→链接、卡片→纯文本），必须留痕；门 B 是能力压根没有统一语义，它照常工作，只是不走动作目录。把这两件事混为一谈，会让「没抽象 = 坏掉了」，而那正是最贵的误解。

## 渠道提示词

静态段与动态来源双轨。

```ts
export interface ChannelProfile {
  identity: string      // 「你在 Discord 服务器 Foo 的 #general 频道，是频道里的助手」
  rules: string[]       // 平台禁忌：2000 字符上限、不能私信未授权用户、不能删历史消息
  formatting: string    // Markdown 降级：不用表格、代码用三个反引号包
  toolHints: string     // 何时该用 like / ban，别乱用
  triggerHint: string   // 群聊里怎么判断该不该回话
}
```

- **静态**：注册为 agent 作用域的 prompt section（随 agent 消亡自动回收）→ 不同渠道 / 不同群人格天然不同；
- **动态**：每条消息的来源事实（channel / senderId / senderName / chatId / threadId / botId）走消息前缀，沿用 dsh-im 已验证的做法：包成 `<dsh_source>` 前缀，渠道补充说明包成 `<dsh_source_guidance>`；
- 分工理由：来源事实每条都变，不能进静态段；静态段进 prompt 会破坏前缀缓存，而前缀会破坏工具集稳定性之外的另一项成本（每条消息多烧 token，且**留在会话历史里**——来源可能含平台用户 ID 或手机号形态标识，需要字段白名单与用户可见开关）。

## 账号与会话绑定

```ts
export interface Account {
  id: string                 // 全局唯一 sid
  platform: string
  accountId: string
  displayName?: string
  enabled: boolean
  protocol: string           // 'onebot11' | 'onebot12' | 'satori' | 'native:discord'
  credentialsRef: string     // 密钥系统引用，不存明文
  capabilities: Capabilities
  rateLimit?: { perSecond?: number; perDay?: number; burst?: number }
}

export interface ChatSession {
  key: string                // platform:accountId:conversationId[:threadId]
  platform: string; accountId: string; conversationId: string
  protocol: string           // 出站走哪条线缆；由产出该事件的驱动决定
  conversationType: 'private' | 'group' | 'guild' | 'channel'
  userId: string
  dshSessionId?: string      // 关联的 DSH session
  replyTo?: { messageId: string }
}
```

**DSH 核心对「一个插件挂多个平台账号」零支持**（只有「bundle → 插件行 → 单份 JSON config」的扁平模型）。账号注册表是本设计必须新增的一等公民。

会话规则：

- 群聊与私聊默认不共享上下文；
- 话题 / 线程用 `threadId` 再分一层；
- 跨平台同一人默认不合并（另建 `userKey`），避免人格串味；
- 私聊总触发；群聊需 @机器人 或命令前缀；`notice` 走专用管道，不唤醒 agent。

## 消息来源的表达

每条 `UserMessage` 恰一个 `MessageSource`（DSH 硬约束 4），而 goal 续轮的 source 被固定为 `{ kind: 'goal', goalId, revision, round }`。因此：

- **「这条来自哪个渠道」只能用消息前缀表达**，不能用 source kind；
- 场所归属由引擎的 venues 映射表反查，不依赖 source。

## 降级、观测、限流

```ts
export interface Degradation { segmentType: string; from: string; to: string
  reason: 'unsupported' | 'too-long' | 'media-converted' | 'passive-only' }
export interface SendResult { messageId?: string; degradations: Degradation[]; idempotencyKey?: string }
```

降级链：

- 图片：直发 → 先下载再发 → 链接文本 → 抛错；
- 卡片：原生 → 平台 markup → 去标记纯文本；
- Markdown：原生 → 平台 markup → 去标记；
- 超限：按段切分 → 按句切分 → 截断并告警。

**每次降级必须留痕**，否则用户在 Discord 看到纯文本却不知道为什么。

限流两级：账号级令牌桶 + 会话级串行队列（借鉴 Koishi `sendQueued` 的 delay 队列）。去重：入站按 `(platform, accountId, eventId | messageId)` 做 LRU + TTL；出站带 `idempotencyKey`。保留 OneBot 11 HTTP POST 的「快速操作」通道（响应体直接 reply / delete / ban，省一次往返）。
