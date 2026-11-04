/**
 * 动作目录 → 模型手里的工具。
 *
 * 这一层只做纯转换：哪些动作可以放开、叫什么名字、参数怎么变成 JSON Schema。
 * 真正注册到 agent 上的是 binding，因为只有它知道这条会话属于哪个场所、哪个驱动。
 */
import type { ActionDescriptor } from './contracts.js'

/**
 * 哪些动作能直接交到模型手里。
 *
 * 只读的、以及**可逆的**写操作可以自主执行；不可逆的一律不开放 ——
 * 审批闸门还没接线，放出去就是让模型替人做决定。
 */
export function exposable(action: ActionDescriptor): boolean {
  if (action.risk === 'read') return true
  return action.risk === 'write' && action.reversible
}

export function exposableActions(actions: readonly ActionDescriptor[]): ActionDescriptor[] {
  return actions.filter(exposable)
}

/** 工具名 = 平台前缀 + 动作名。权限规则按同一个名字匹配（`qq_*`）。 */
export function toolName(platform: string, action: ActionDescriptor): string {
  return `${platform}_${action.name}`
}

interface ParameterSpec {
  type?: string
  required?: boolean
  description?: string
}

/**
 * 动作的参数声明换成 JSON Schema。
 *
 * 驱动的声明只有一层：每个参数一个 type，可标 required。要传结构就写 json 或字符串，
 * 不在这里造嵌套 —— 嵌套会让同一份声明有两种形状。
 */
export function parameterSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, raw] of Object.entries(parameters)) {
    const spec = (raw ?? {}) as ParameterSpec
    const type = spec.type ?? 'string'
    properties[key] = {
      // json 参数接受任意结构；JSON Schema 里就是不限定类型。
      ...(type === 'json' ? {} : { type }),
      ...(spec.description === undefined ? {} : { description: spec.description }),
    }
    if (spec.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) }
}

/**
 * 每个工具都多一个参数：**这次是替谁做的**。
 *
 * 不声明就等于没交代 —— 判定时按最窄的算。声明了也要对得上这一轮真的在说话的人，
 * 免得模型替一个没开口的人做主。
 */
export const PRINCIPAL_PARAMETER = {
  type: 'string',
  description: '这次调用是替谁做的：说话人的用户 id；如果是你自己决定的，填 self。不确定就别调用。',
}

/** 一个动作在模型视野里的样子：名字、说明、参数 schema。 */
export function toolSpec(platform: string, action: ActionDescriptor): {
  name: string
  description: string
  parameters: Record<string, unknown>
} {
  const schema = parameterSchema((action.parameters ?? {}) as Record<string, unknown>)
  return {
    name: toolName(platform, action),
    description: action.description,
    parameters: {
      ...schema,
      properties: { ...(schema.properties as Record<string, unknown>), principal: PRINCIPAL_PARAMETER },
      required: [...((schema.required as string[] | undefined) ?? []), 'principal'],
    },
  }
}
