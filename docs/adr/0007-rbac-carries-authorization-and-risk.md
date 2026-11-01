# ADR-0007：风险与授权都归角色矩阵

> **状态**：`accepted`
> **日期**：2026-11-01
> **落地阶段**：P0
> **上游材料**：[capability token](../reference/contracts-persona.md#capability-token)、[判据与默认值](../reference/policies.md)、[ADR-0006](0006-capability-two-doors.md)

## 背景

原先的分工是：驱动在 `ActionDescriptor.risk` 里声明风险，内核按一张**内建**的表处置 —— read 放行、write 记录、destructive 必须问人。用户改不了这张表。

这有两个问题：

- 门 B 没有风险等级（我们判不了，见 [ADR-0006](0006-capability-two-doors.md)），于是它要么被一刀切，要么被排除在策略之外 —— 两种都不对；
- 「要不要问人」本质上是**部署者的偏好**，不是内核能替他决定的事。同一个人可能想让机器人在自己群里完全放手，在客户群里一个动作一问。

## 决策

**一张矩阵，键是角色，值是一组规则。风险只提供默认值。**

```ts
type Decision = 'allow' | 'ask' | 'deny'
interface PermissionRule { match: string; decision: Decision }   // match: '{platform}_{action}' · 'mcp__<serverName>__*' · '*'
type Role = string                                                // 出厂五个是种子，用户可以加
type PermissionMatrix = Record<Role, PermissionRule[]>
```

`autonomous` 也要占一格：定时、做梦、主动发言这些回合没有发起人，它们的权限不能借用任何人的角色 —— 否则「机器人自己决定做的事」会隐式继承主人的权限。

## 角色是用户可扩展的，但落点只有一个

内置角色是种子，不是封闭集合。用户可以加「运营」「客户」「VIP」，可以改名，可以删掉不用的 —— 权限系统不该规定一个社群分几种人。

但**必须有一个落点**：身份表里查不到的 subject 一律落进默认角色（出厂叫 `guest`）。这个落点删不掉、补不了配置、也不能被配得更高，它在代码里硬拦。红线 4 就挂在这里 —— 否则「新建一个角色、把陌生人放进去、权限全开」就能绕过它，而绕过是静默的。

角色之间**不做继承**。继承会把「取最严」变成算一条链，链上任何一处配错都是静默放大；平铺的规则列表，出问题只看一行。

一次工具调用的判定顺序：

1. **token 校验**（过期 / `epoch` / `scope` / 验签）不过 → `deny`；
2. 命中的规则取**最严**（`deny` > `ask` > `allow`）；
3. 没命中 → 工具的原生默认；
4. 原生默认也没有（门 B）→ `deny`。

用户给自己的角色写一条 `{ match: '*', decision: 'allow' }`，就是「我的群我说了算，全放手」。那是他的权利，我们不做假设。

形状参照 Claude Code 的权限规则（`allow` / `ask` / `deny` 三值 + 规则匹配 + 模式预设；未逐条核对官方文档，此处只取形状）。我们只多一维：**角色** —— 它面对的是单人终端，我们面对的是多人场所。

## 被否决的替代

| 替代 | 否决理由 |
|---|---|
| 保留内建的固定风险表 | 用户改不了，且门 B 无处安放 |
| 让驱动声明 risk | 能写出风险等级的已经该抽象进门 A（[ADR-0006](0006-capability-two-doors.md)） |
| 只给「全放 / 全问」两个开关 | 表达不了「可逆的放开、不可逆的问」，而那是整套设计里最有价值的一档 |
| 把矩阵写死在代码里 | 同「保留内建表」 |

## 影响

- **红线 5 降级。**「凭据永远要留」不变（每个对外动作必须生成 `ActionReceipt`）；但「无 undo 的动作只能走审批」从红线变成**默认值**，可被矩阵覆盖。理由：那是偏好，不是安全属性 —— 用户授权自己的身体去做不可逆的事，本来就是权利。
- **红线 4 不变。** guest 的下限不是偏好，是边界：陌生人说的话本来就不是授权（红线 3），所以他的账没人替他付得起。
- `verify(): boolean` 表达不了 `ask`，改成 `decide(): Decision`。词表与 DSH 的 `tools/pre-execute` 闸门同构（`allow` / `ask` / `deny`），映射是恒等。
- [ADR-0001](0001-risk-criterion.md) 的判据（可逆性 × 影响半径）不变，但它影响清单里的最后一条「不可逆 ⇒ 自主时直接拒绝」被本决策放宽为「出厂默认问人」。
- 出厂矩阵见[判据与默认值](../reference/policies.md#出厂矩阵)，它是默认值，不是规则。

## 指针

- 矩阵与 `decide()` 的形状：[capability token](../reference/contracts-persona.md#capability-token)
- 出厂矩阵与判定顺序：[判据与默认值](../reference/policies.md#出厂矩阵)
