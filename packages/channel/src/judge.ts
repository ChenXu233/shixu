/**
 * 判官：这一批消息，值不值得抬头看一眼。
 *
 * 两种后端，一个接口：
 *   `model` —— 一个聊天模型回一行（现在在用）
 *   `jev`   —— TypeSafe 的 System One 模型，一次 HTTP POST，返回选项与概率
 *
 * 选 `choice` 而不是 `noul`：**选中的那个选项本身就是理由**。二分类只能给「是/否」，
 * 分档却能同时告诉我们「为什么值得」和「为什么不该看」。
 */
export interface JudgeVerdict {
  /** 要不要去看。 */
  look: boolean
  /** 理由（选项自带，不需要模型再解释一遍）。 */
  reason: string
  /** 0..1：判得多有把握。model 后端没有这个概念，给 1。 */
  confidence: number
}

/** 判官能选的档位。value 是它真正要做的决定，criteria 是给模型看的判据。 */
export const ATTENTION_OPTIONS = {
  asks_question: {
    look: true,
    reason: '有人在问问题',
    criteria: '有人在问具体的问题、求助、或者明显想知道答案',
  },
  substantive: {
    look: true,
    reason: '在说正经事',
    criteria: '在聊具体的事，跟她在意的东西有关（动物、科学、生活里的事）',
  },
  greeting: {
    look: false,
    reason: '只是打招呼',
    criteria: '只是打招呼、寒暄、互相说早',
  },
  noise: {
    look: false,
    reason: '刷屏或水贴',
    criteria: '刷屏、表情、无意义的短句、复读',
  },
  private_talk: {
    look: false,
    reason: '别人的私事或吵架',
    criteria: '别人之间的私事、吵架、与群里其他人无关的对话',
  },
} as const

export type AttentionChoice = keyof typeof ATTENTION_OPTIONS

/** 一次 JEV 判定的请求体。 */
export function jevRequest(state: string, model: string = 'jev-latest'): unknown {
  const criteria: Record<string, string> = {}
  for (const [key, option] of Object.entries(ATTENTION_OPTIONS)) criteria[key] = option.criteria

  return {
    model,
    state,
    questions: {
      attention: {
        type: 'choice',
        instructions: '群里刚来了这几条消息。现在值得她抬头看一眼吗？为什么？',
        criteria,
      },
    },
  }
}

/**
 * 读 JEV 的回答。
 *
 * 认不出来的选项一律当「不看」——判官失手时，沉默比插话便宜。
 */
export function readJevAnswer(payload: unknown): JudgeVerdict {
  const answer = (payload as { answers?: { attention?: { choice?: unknown; confidence?: unknown } } } | undefined)?.answers
    ?.attention
  const choice = typeof answer?.choice === 'string' ? (answer.choice as AttentionChoice) : undefined
  const confidence = typeof answer?.confidence === 'number' ? answer.confidence : 0

  const option = choice === undefined ? undefined : ATTENTION_OPTIONS[choice]
  if (option === undefined) return { look: false, reason: '判官没给出可用的选项', confidence }
  return { look: option.look, reason: option.reason, confidence }
}

export interface JevOptions {
  state: string
  baseUrl: string
  apiKey: string
  model?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** 问 JEV 一次。失败就抛出，由调用方决定退到哪。 */
export async function askJev(options: JevOptions): Promise<JudgeVerdict> {
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)
  try {
    const response = await doFetch(`${options.baseUrl.replace(/\/$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(jevRequest(options.state, options.model)),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`JEV ${response.status}：${(await response.text()).slice(0, 200)}`)
    return readJevAnswer(await response.json())
  } finally {
    clearTimeout(timer)
  }
}
