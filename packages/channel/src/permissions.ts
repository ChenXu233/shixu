/**
 * 身份与权限：两个类型，一个判定函数。
 *
 * 这是纯逻辑，不认识 Cordis、不认识事件。钩子（`tools/pre-execute`）调它，
 * 它只回答 `allow` / `ask` / `deny`。
 *
 * 契约见 docs/reference/contracts-persona.md#身份与权限。
 */

/** 出厂角色只是种子；用户可以加自己的。 */
export type Role = string

export type Decision = 'allow' | 'ask' | 'deny'

/** 一个回合的发起者。三个字段，别的不要。 */
export interface TurnActor {
  /** 平台用户 id；身份表的键。 */
  subject: string
  /** 查出来的角色，本回合内固定。 */
  role: Role
  /** 防跨场所冒用：A 群的身份不能在 B 群用。 */
  venueId: string
}

/** 一条规则：这个角色对这个工具名给一个决定。 */
export interface PermissionRule {
  /** '{platform}_{action}' · 'mcp__<serverName>__*' · '*' */
  match: string
  decision: Decision
}

export type PermissionMatrix = Record<Role, PermissionRule[]>

/** 工具自带的已知信息。门 B 的工具这两项都缺，那就是「我们不知道它是什么」。 */
export interface ToolFacts {
  name: string
  risk?: 'read' | 'write' | 'destructive'
  reversible?: boolean
}

/** 身份表 + 规则表。缺一不可，所以绑在一起传入。 */
export interface PermissionSet {
  matrix: PermissionMatrix
  /** 身份表查不到时落进的角色；红线 4 挂在这个角色上。 */
  fallback: Role
}

/** 通配只有一种：`*` 匹配任意字符序列，其余按字面。 */
export function matchesPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true
  if (!pattern.includes('*')) return false

  const parts = pattern.split('*')
  let cursor = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string
    if (i === 0) {
      if (!name.startsWith(part)) return false
      cursor = part.length
    } else if (i === parts.length - 1) {
      if (!name.endsWith(part) || name.length - cursor < part.length) return false
    } else {
      const found = name.indexOf(part, cursor)
      if (found < 0) return false
      cursor = found + part.length
    }
  }
  return true
}

/** 「不可逆 + 高影响」——红线 4 唯一需要认得出的一类。 */
function isHighImpactIrreversible(tool: ToolFacts): boolean {
  return tool.risk === 'destructive' && tool.reversible === false
}

/**
 * 判定一次工具调用。
 *
 * 1. 从后往前，第一条命中的规则胜出（后面的覆盖前面的）；
 * 2. 一条都没命中 → 工具的原生默认；
 * 3. 原生默认也没有（门 B）→ deny。
 *
 * 然后过一遍红线 4：未识别者的落点拿不到「不可逆 + 高影响」，配置改不动它。
 */
export function authorize(
  set: PermissionSet,
  actor: TurnActor,
  tool: ToolFacts,
  native?: Decision,
): Decision {
  if (actor.role === set.fallback && isHighImpactIrreversible(tool)) return 'deny'

  const rules = set.matrix[actor.role] ?? []
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i] as PermissionRule
    if (matchesPattern(rule.match, tool.name)) return rule.decision
  }
  return native ?? 'deny'
}

/**
 * 身份表：platform + accountId → 角色。
 *
 * 查不到一律落进 fallback。这不是「宽松的默认」，是红线 4 的载体 ——
 * 陌生人说的话本来就不是授权，所以他的账没人替他付。
 */
export class IdentityTable {
  private readonly roles = new Map<string, Role>()

  constructor(private readonly fallback: Role = 'guest') {}

  /** 把某个平台账号认成某个角色。主人显式设定，模型改不了。 */
  set(platform: string, accountId: string, role: Role): void {
    this.roles.set(`${platform}:${accountId}`, role)
  }

  remove(platform: string, accountId: string): void {
    this.roles.delete(`${platform}:${accountId}`)
  }

  roleOf(platform: string, accountId: string): Role {
    return this.roles.get(`${platform}:${accountId}`) ?? this.fallback
  }
}
