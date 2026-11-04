import { describe, expect, it } from 'vitest'
import type { ActionDescriptor, UnifiedEvent } from '../lib/contracts.js'
import { judge, roleOf, seedMatrix, turnActorOf } from '../lib/permission.js'

const action = (over: Partial<ActionDescriptor>): ActionDescriptor => ({
  name: 'probe',
  description: '探针',
  parameters: {},
  risk: 'read',
  reversible: true,
  scope: 'venue',
  ...over,
})

const ACTIONS = [
  action({ name: 'member_list', risk: 'read' }),
  action({ name: 'mute', risk: 'write', reversible: true }),
]

const event = (over: Partial<UnifiedEvent> & { role?: string } = {}): UnifiedEvent => ({
  id: 'e1',
  type: 'message',
  venue: { platform: 'qq', accountId: 'bot', conversationId: 'g1' },
  conversationType: 'group',
  timestamp: 0,
  self: false,
  actor: { id: 'u1', ...(over.role === undefined ? {} : { role: over.role }) },
  message: [],
  ...over,
})

/**
 * 破损类：**不该动手的人让它动了手**。
 * 用户看到：群里随便一个人 @ 它，就能让它把别人禁言。
 */
describe('这个人是谁', () => {
  it('主人在哪都是主人，包括私聊', () => {
    expect(roleOf({ id: 'boss', role: 'member' }, ['boss'], 'group')).toBe('owner')
    expect(roleOf({ id: 'boss' }, ['boss'], 'private')).toBe('owner')
  })

  it('群主和管理员算 trusted，普通成员算 member', () => {
    expect(roleOf({ id: 'a', role: 'owner' }, [], 'group')).toBe('trusted')
    expect(roleOf({ id: 'b', role: 'admin' }, [], 'group')).toBe('trusted')
    expect(roleOf({ id: 'c', role: 'member' }, [], 'group')).toBe('member')
  })

  it('私聊里的陌生人只是 guest，不是 member', () => {
    expect(roleOf({ id: 'stranger' }, [], 'private')).toBe('guest')
  })

  it('认不出是谁就按 guest 算', () => {
    expect(roleOf(undefined, [], 'group')).toBe('guest')
    expect(roleOf({ id: '' }, [], 'group')).toBe('guest')
  })
})

describe('能不能动手', () => {
  const matrix = seedMatrix('qq', ACTIONS)

  it('只读动作谁都能用', () => {
    for (const role of ['owner', 'trusted', 'member']) {
      expect(judge(matrix, role, 'qq_member_list')).toBe('allow')
    }
  })

  it('可逆的写动作只给主人和群管理者', () => {
    expect(judge(matrix, 'owner', 'qq_mute')).toBe('allow')
    expect(judge(matrix, 'trusted', 'qq_mute')).toBe('allow')
    expect(judge(matrix, 'member', 'qq_mute')).toBe('deny')
  })

  it('陌生人一个工具都用不了', () => {
    expect(judge(matrix, 'guest', 'qq_member_list')).toBe('deny')
    expect(judge(matrix, 'guest', 'qq_mute')).toBe('deny')
  })

  it('不认识的角色一律拒绝 —— 配置里没有的比陌生人更可疑', () => {
    expect(judge(matrix, 'vip', 'qq_member_list')).toBe('deny')
  })

  it('规则从后往前判，后面写的覆盖前面的', () => {
    const override = {
      ...matrix,
      member: [...matrix.member!, { match: 'qq_mute', decision: 'allow' as const }],
    }
    expect(judge(override, 'member', 'qq_mute')).toBe('allow')
  })

  it('通配符能按前缀放行一整类工具', () => {
    const prefix = { owner: [{ match: '*', decision: 'deny' as const }, { match: 'qq_*', decision: 'allow' as const }], trusted: [], member: [], guest: [], autonomous: [] }
    expect(judge(prefix, 'owner', 'qq_mute')).toBe('allow')
    expect(judge(prefix, 'owner', 'mcp__calendar__add')).toBe('deny')
  })
})

describe('一回合的发起者', () => {
  it('带上是哪个场所：A 群的身份不能在 B 群用', () => {
    const actor = turnActorOf(event({ role: 'admin' }), [])
    expect(actor.role).toBe('trusted')
    expect(actor.venueId).toContain('g1')
  })
})
