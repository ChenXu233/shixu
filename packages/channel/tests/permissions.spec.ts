import { describe, expect, it } from 'vitest'
import { authorize, IdentityTable, matchesPattern } from '../lib/permissions.js'
import type { PermissionSet, TurnActor } from '../lib/permissions.js'

/**
 * 这里只验证**必要的正确性**：契约里写了什么，就测什么。
 * 不为「某一行可能被改坏」写测试 —— 那种覆盖是变异测试的职责，不是日常测试的。
 */

const owner: TurnActor = { subject: 'u-owner', role: 'owner', venueId: 'qq:bot:g1' }
const stranger: TurnActor = { subject: 'u-stranger', role: 'guest', venueId: 'qq:bot:g1' }

function set(matrix: PermissionSet['matrix']): PermissionSet {
  return { matrix, fallback: 'guest' }
}

describe('规则表', () => {
  it('后面的规则赢：兜底不会吃掉具体放行', () => {
    const ps = set({
      owner: [
        { match: '*', decision: 'deny' },
        { match: 'qq_*', decision: 'ask' },
        { match: 'qq_like', decision: 'allow' },
      ],
    })
    const tool = (name: string) => ({ name })

    expect(authorize(ps, owner, tool('qq_like'))).toBe('allow')
    expect(authorize(ps, owner, tool('qq_ban'))).toBe('ask')
    expect(authorize(ps, owner, tool('mcp__calendar__create'))).toBe('deny')
  })

  it('一条都不命中：用原生默认，没有原生默认就拒绝', () => {
    const ps = set({ owner: [{ match: 'qq_*', decision: 'allow' }] })
    const tool = { name: 'web_search' }

    expect(authorize(ps, owner, tool, 'ask')).toBe('ask')
    expect(authorize(ps, owner, tool)).toBe('deny')
  })

  it('通配可以按 server 授，不必认识单个工具', () => {
    expect(matchesPattern('mcp__calendar__*', 'mcp__calendar__create')).toBe(true)
    expect(matchesPattern('mcp__calendar__*', 'mcp__other__create')).toBe(false)
    expect(matchesPattern('*', 'anything')).toBe(true)
  })
})

describe('身份表', () => {
  it('查不到的人落进默认角色，查到的人用认好的角色', () => {
    const table = new IdentityTable()
    table.set('qq', 'owner-uin', 'owner')

    expect(table.roleOf('qq', 'owner-uin')).toBe('owner')
    expect(table.roleOf('qq', 'never-seen')).toBe('guest')
  })

  it('默认角色拿不到「不可逆 + 高影响」，即使矩阵写了 allow', () => {
    const ps = set({ guest: [{ match: '*', decision: 'allow' }] })

    expect(authorize(ps, stranger, { name: 'qq_kick', risk: 'destructive', reversible: false })).toBe('deny')
    // 可逆的照样按矩阵走 —— 收紧的是「不可逆 + 高影响」这一类，不是整个角色。
    expect(authorize(ps, stranger, { name: 'qq_like', risk: 'write', reversible: true })).toBe('allow')
  })
})
