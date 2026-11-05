/**
 * 谁能让它做什么 —— 权限只有一个来源：主人自己写的信任表。
 *
 * 平台告诉我们的事实（这个人是群主、那个是管理员）**不是权限**。群主能管住那个群，
 * 不等于他能指挥这台机器。把「群管理员」直接当授权，等于让任何一个群的群主
 * 都能让 agent 跑 bash —— 而他们很可能根本不认识主人。
 *
 * 所以：身份表里查得到的人才有角色，查不到的一律是 guest。guest 也能聊天、
 * 也能让它做只读的活；写动作只属于主人和他亲手放进去的人。
 */
import type { ActionDescriptor } from './contracts.js'
import { toolName } from './capabilities.js'

/** 出厂角色只是种子。 */
export type BuiltinRole = 'owner' | 'trusted' | 'guest' | 'autonomous'
export type Role = string

/** 身份表：只有主人写的才算数。查不到的 subject 落到 guest。 */
export interface Identity {
  owners: readonly string[]
  trusted?: readonly string[]
}

export interface PermissionRule {
  /** 工具名，支持 `*` 通配。 */
  match: string
  decision: 'allow' | 'ask' | 'deny'
}

export type PermissionMatrix = Record<Role, PermissionRule[]>

export interface TurnActor {
  /** 平台用户 id；`self` 表示它自己决定做的。 */
  subject: string
  role: Role
  venueId: string
}

/** 声明「这次是替谁做的」。没声明就等于没交代，按最窄的算。 */
export const SELF = 'self'

export function roleOf(subject: string, identity: Identity): Role {
  if (subject === SELF) return 'autonomous'
  if (subject === '') return 'guest'
  if (identity.owners.includes(subject)) return 'owner'
  if ((identity.trusted ?? []).includes(subject)) return 'trusted'
  return 'guest'
}

/** 从一条消息的发起人算出这一回合的身份。 */
export function turnActorOf(subject: string, identity: Identity, venueId: string): TurnActor {
  return { subject: subject === '' ? SELF : subject, role: roleOf(subject, identity), venueId }
}

/**
 * 出厂矩阵：兜底拒绝，然后逐条放开。
 *
 * owner 什么都能用（那是他的机器）；trusted 能用这个场所里的动作（含可逆的写），
 * 但碰不到主机上的工具；guest 只有只读的场所动作。规则从后往前判，读起来就是执行顺序。
 */
export function seedMatrix(
  platform: string,
  actions: readonly ActionDescriptor[],
  kernel: readonly string[] = [],
  ownerOnly: readonly string[] = [],
): PermissionMatrix {
  const names = actions.map((action) => ({
    name: toolName(platform, action),
    read: action.risk === 'read',
  }))

  // 内核工具（看历史、说话）是在场的基本能力，任何角色都该有：
  // 不让 guest 说话，等于它连回一句都做不到。
  const speak: PermissionRule[] = kernel.map((name) => ({ match: name, decision: 'allow' as const }))

  const readOnly: PermissionRule[] = [
    { match: '*', decision: 'deny' },
    ...speak,
    ...names.filter((item) => item.read).map((item) => ({ match: item.name, decision: 'allow' as const })),
  ]

  // 只给主人和它自己：记忆会传染，陌生人不能往它脑子里写东西。
  const mine: PermissionRule[] = ownerOnly.map((name) => ({ match: name, decision: 'allow' as const }))

  return {
    owner: [{ match: '*', decision: 'allow' }],
    trusted: [
      { match: '*', decision: 'deny' },
      ...speak,
      ...names.map((item) => ({ match: item.name, decision: 'allow' as const })),
    ],
    guest: readOnly,
    autonomous: [...readOnly.filter((rule) => rule.match !== '*'), ...mine],
  }
}

/** 判定：从后往前找第一条命中的；一条都没命中就是不认。 */
export function judge(matrix: PermissionMatrix, role: Role, name: string): 'allow' | 'ask' | 'deny' {
  const rules = matrix[role]
  if (rules === undefined) return 'deny'
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]
    if (rule !== undefined && matches(rule.match, name)) return rule.decision
  }
  return 'deny'
}

/** `qq_*` 这种前缀通配就够用了；中间通配也照着处理，不用正则。 */
function matches(pattern: string, name: string): boolean {
  if (pattern === '*') return true
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === name
  const head = pattern.slice(0, star)
  const tail = pattern.slice(star + 1)
  return name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail)
}
