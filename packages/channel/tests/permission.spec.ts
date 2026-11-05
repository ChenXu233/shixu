import { describe, expect, it } from 'vitest'
import type { ActionDescriptor } from '../lib/contracts.js'
import { judge, roleOf, seedMatrix, SELF } from '../lib/permission.js'

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

/**
 * 破损类：**不认识的人摘到了它的能力**。
 * 用户看到：随便一个群的群主 @ 它一句，它就去跑命令。
 */
describe('角色只来自主人的信任表', () => {
  const trust = { owners: ['boss'], trusted: ['mate'] }

  it('信任表里写了才算，写了的跨场所都算', () => {
    expect(roleOf('boss', trust)).toBe('owner')
    expect(roleOf('mate', trust)).toBe('trusted')
  })

  it('没写的一律是 guest —— 群里是不是管理员，平台说了不算', () => {
    expect(roleOf('someone', trust)).toBe('guest')
    expect(roleOf('', trust)).toBe('guest')
  })

  it('自己决定做的算 autonomous', () => {
    expect(roleOf(SELF, trust)).toBe('autonomous')
  })
})

describe('出厂矩阵', () => {
  const matrix = seedMatrix('qq', ACTIONS, ['qq_history', 'qq_send', 'qq_reply_to'])

  it('主人什么都能用，包括主机上的工具', () => {
    expect(judge(matrix, 'owner', 'qq_mute')).toBe('allow')
    expect(judge(matrix, 'owner', 'bash')).toBe('allow')
  })

  it('信得过的人能用这个场所的动作，但碰不到主机', () => {
    expect(judge(matrix, 'trusted', 'qq_mute')).toBe('allow')
    expect(judge(matrix, 'trusted', 'bash')).toBe('deny')
  })

  it('guest 能聊天、能问只读的东西，但动不了手', () => {
    expect(judge(matrix, 'guest', 'qq_member_list')).toBe('allow')
    expect(judge(matrix, 'guest', 'qq_mute')).toBe('deny')
    expect(judge(matrix, 'guest', 'bash')).toBe('deny')
  })

  it('自己决定做的，只做只读的事', () => {
    expect(judge(matrix, 'autonomous', 'qq_member_list')).toBe('allow')
    expect(judge(matrix, 'autonomous', 'qq_mute')).toBe('deny')
  })

  it('看历史和说话是任何角色的基本能力：连回一句都不行的 guest 不叫 guest', () => {
    for (const role of ['owner', 'trusted', 'guest', 'autonomous']) {
      expect(judge(matrix, role, 'qq_history')).toBe('allow')
      expect(judge(matrix, role, 'qq_send')).toBe('allow')
    }
  })

  it('规则从后往前判，后面写的覆盖前面的', () => {
    const override = { ...matrix, guest: [...matrix.guest!, { match: 'qq_mute', decision: 'allow' as const }] }
    expect(judge(override, 'guest', 'qq_mute')).toBe('allow')
  })

})
