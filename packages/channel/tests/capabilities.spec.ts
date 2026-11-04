import { describe, expect, it } from 'vitest'
import { exposable, exposableActions, parameterSchema, toolName, toolSpec } from '../lib/capabilities.js'
import type { ActionDescriptor } from '../lib/contracts.js'

const action = (over: Partial<ActionDescriptor>): ActionDescriptor => ({
  name: 'probe',
  description: '探针',
  parameters: {},
  risk: 'read',
  reversible: true,
  scope: 'venue',
  ...over,
})

/**
 * 破损类：**模型拿到了它不该自主执行的能力**，或者**参数表跟驱动声明对不上**。
 * 用户看到：机器人在群里把人踢了；或者它调工具时永远填错参数。
 */
describe('哪些动作能交给模型', () => {
  it('只读的放开', () => {
    expect(exposable(action({ risk: 'read' }))).toBe(true)
  })

  it('可逆的写操作放开', () => {
    expect(exposable(action({ risk: 'write', reversible: true }))).toBe(true)
  })

  it('不可逆的写操作不放开：撤回不了的事不能让模型自己拍板', () => {
    expect(exposable(action({ risk: 'write', reversible: false }))).toBe(false)
  })

  it('高影响动作一律不放开', () => {
    expect(exposable(action({ risk: 'destructive', reversible: true }))).toBe(false)
  })

  it('目录过一遍，只留下能放开的', () => {
    const kept = exposableActions([
      action({ name: 'member_list', risk: 'read' }),
      action({ name: 'mute', risk: 'write', reversible: true }),
      action({ name: 'kick', risk: 'destructive', reversible: false }),
    ])
    expect(kept.map((one) => one.name)).toEqual(['member_list', 'mute'])
  })
})

describe('工具名与参数', () => {
  it('工具名带平台前缀：权限规则按同一个名字匹配', () => {
    expect(toolName('qq', action({ name: 'kick' }))).toBe('qq_kick')
  })

  it('required 与 description 原样带进 JSON Schema，json 参数不限定类型', () => {
    const schema = parameterSchema({
      groupId: { type: 'string', required: true, description: '群号' },
      payload: { type: 'json' },
    })

    expect(schema).toEqual({
      type: 'object',
      properties: {
        groupId: { type: 'string', description: '群号' },
        payload: {},
      },
      required: ['groupId'],
    })
  })

  it('没有必填参数就不写 required 字段', () => {
    const schema = parameterSchema({ text: { type: 'string' } }) as { required?: unknown }
    expect(schema.required).toBeUndefined()
  })

  it('动作变成模型视野里的一条工具声明，并且必须声明替谁做', () => {
    const spec = toolSpec('qq', action({ name: 'member_list', description: '看看群里有哪些人', parameters: {} }))
    expect(spec.name).toBe('qq_member_list')
    expect(spec.description).toBe('看看群里有哪些人')

    const schema = spec.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(schema.required).toEqual(['principal'])
    expect(schema.properties.principal).toBeDefined()
  })
})
