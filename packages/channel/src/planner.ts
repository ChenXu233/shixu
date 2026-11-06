/**
 * 判官：这一批消息，值不值得它抬头看一眼。
 *
 * MaiBot 让一个模型来判（Planner）。我们照抄，但把判的范围收窄：**只判「有人在聊」
 * 这一种情况**——被 @、叫到名字、私聊、冷场探访，都是机械规则，不需要花钱问模型。
 *
 * 判官用独立会话、独立模型：将来换成 JEV 这类「结构化决策」的小模型，只改配置，
 * 不动这里。它只回答一个词，不做别的。
 */
export interface PlannerMessage {
  id: string
  speaker: string
  text: string
}

export interface PlannerInput {
  /** 人格的一句话摘要，让判官知道这是谁在判。 */
  persona: string
  /** 攒着没看的那批消息。 */
  messages: readonly PlannerMessage[]
  /** 距上次在这个场所说话多久（分钟）。 */
  minutesSinceSpoke?: number
}

/** 判官看到的输入。刻意短：它只需要决定值不值得看，不需要懂全部背景。 */
export function plannerPrompt(input: PlannerInput): string {
  const lines = input.messages.map((one) => `[${one.id}] ${one.speaker}：${one.text}`)
  return [
    `你是「${input.persona}」的判断力。群里刚来了这么几条消息，你要决定：现在值不值得进去看一眼。`,
    '值得的标准：有人在说正经事、有人在问问题、话题跟你在意的东西有关。',
    '不值得的标准：只是打招呼、发表情闲聊、刷屏、别人之间的私事、吵架。',
    input.minutesSinceSpoke === undefined ? '' : `（你上次在这个群说话是 ${input.minutesSinceSpoke} 分钟前。）`,
    '',
    ...lines,
    '',
    '只回答一行：值得 或 不值得，后面跟不超过十个字的理由。',
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}

export interface PlannerVerdict {
  /** 值不值得看。 */
  look: boolean
  /** 模型给的理由；没给就是空串。 */
  reason: string
}

/**
 * 解析判官的回话。
 *
 * 宽容一点：模型可能写「值得」「YES」「值得看一眼」。「不值得」里也含「值得」，
 * 所以先判否定，再判肯定 —— 顺序错了会把拒绝读成同意。
 */
export function parseVerdict(text: string): PlannerVerdict {
  const clean = text.trim()
  if (clean === '') return { look: false, reason: '' }

  const firstLine = clean.split('\n')[0]!.trim()
  const reason = firstLine.replace(/^(值得|不值得|yes|no|YES|NO)[：:，,\s]*/i, '').trim()

  if (/^(不值得|不要|不看|no\b)/i.test(firstLine)) return { look: false, reason }
  if (/^(值得|要看|看|yes\b)/i.test(firstLine)) return { look: true, reason }
  // 说了别的：宁可当「不看」——判官失手时沉默比插话便宜。
  return { look: false, reason: firstLine.slice(0, 20) }
}
