/**
 * 谁能让它做什么。
 *
 * 一个字都不多：先看说话的人在这个场所是什么角色，再按规则表从后往前找第一条命中的，
 * 没有命中就是不认。规则表是配置，判定是函数，仅此两样（ADR-0007）。
 *
 * 为什么角色按场所算：同一个人在 A 群是管理员，在 B 群什么都不是。
 * 身份跟场所绑定，不跟账号绑定。
 */
import type { ActionDescriptor, UnifiedEvent } from './contracts.js'
import { toolName } from './capabilities.js'
import { venueKeyOf } from './contracts.js'

/** 出厂角色只是种子；用户可以加自己的。 */
export type BuiltinRole = 'owner' | 'trusted' | 'member' | 'guest' | 'autonomous'
export type Role = string

/** 一个回合的发起者。三个字段，别的不要。 */
export interface TurnActor {
  /** 平台用户 id。 */
  subject: string
  /** 查出来的角色，本回合内固定。 */
  role: Role
  /** 防跨场所冒用：A 群的身份不能在 B 群用。 */
  venueId: string
}

export interface PermissionRule {
  /** 工具名，支持 `*` 通配。 */
  match: string
  decision: 'allow' | 'ask' | 'deny'
}

export type PermissionMatrix = Record<Role, PermissionRule[]>

export type VenueKind = 'private' | 'group' | 'channel'

/**
 * 把「平台说这个人是谁」翻成「人格认的角色」。
 *
 * 主人是唯一能跨场所的：他在哪个群都是 owner，因为那是人格的拥有者，
 * 不是某个群的头衔。其余一律就地取材 —— 群主与管理员算 trusted，
 * 普通成员算 member，私聊里的陌生人算 guest。
 */
export function roleOf(
  actor: { id?: string; role?: string } | undefined,
  owners: readonly string[],
  kind: VenueKind,
): Role {
  const subject = actor?.id ?? ''
  if (subject === '') return 'guest'
  if (owners.includes(subject)) return 'owner'
  if (kind === 'private') return 'guest'
  if (actor?.role === 'owner' || actor?.role === 'admin') return 'trusted'
  return 'member'
}

/** 一条消息的发起者，用来做这一回合的权限判定。 */
export function turnActorOf(event: UnifiedEvent, owners: readonly string[]): TurnActor {
  return {
    subject: event.actor?.id ?? '',
    role: roleOf(event.actor, owners, event.conversationType),
    venueId: venueKeyOf(event),
  }
}

/**
 * 出厂矩阵：兜底拒绝，然后按动作风险逐条放开。
 *
 * 只读动作谁都能用（本来就能看见）；可逆的写动作只给主人和群里的管理者。
 * 规则按「从后往前」判，所以读起来就是执行顺序。
 */
export function seedMatrix(platform: string, actions: readonly ActionDescriptor[]): PermissionMatrix {
  const rules = (writes: boolean): PermissionRule[] => [
    { match: '*', decision: 'deny' },
    ...actions
      .filter((action) => action.risk === 'read' || (writes && action.risk === 'write' && action.reversible))
      .map((action) => ({ match: toolName(platform, action), decision: 'allow' as const })),
  ]

  return {
    owner: rules(true),
    trusted: rules(true),
    member: rules(false),
    guest: [{ match: '*', decision: 'deny' }],
    autonomous: rules(false),
  }
}

/**
 * 判定三步里的后两步：从后往前找第一条命中的规则；一条都没命中就是拒绝。
 * 角色不认识（配置里没有）也当拒绝 —— 不认识的比陌生人更危险。
 */
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
