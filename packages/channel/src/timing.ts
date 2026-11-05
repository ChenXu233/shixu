/**
 * 说话的样子：先说多少、隔多久再说下一句。
 *
 * 人不是「秒回一大段」：先看一眼，打几个字，发出去；想到补充再发一条。
 * 这两件事都很便宜，但少了它们，再聪明的回复也一眼是机器人。
 *
 * 全都是纯函数 —— 想换节奏只改这里，不动出站的代码。
 */

/** 打字速度（每秒几个字）与思考停顿。数值来自常见的中文手机打字速度区间。 */
export const TYPING_CHARS_PER_SECOND = 8
export const THINKING_MS = 600
/** 单条消息最多等这么久：等 20 秒再发，比秒回更像掉线。 */
export const MAX_DELAY_MS = 6_000

/**
 * 这条消息该等多久再发。
 *
 * 基础停顿 + 按字数算的打字时间，再加一点抖动 —— 每次都是精确相同的延迟，
 * 本身就是一个破绽。
 */
export function typingDelay(text: string, baseMs: number = THINKING_MS, random: () => number = Math.random): number {
  // 0 表示不等：测试与「我要它立刻回」的场合都走这条。
  if (baseMs <= 0) return 0

  const typed = (text.length / TYPING_CHARS_PER_SECOND) * 1_000
  const jitter = 0.85 + random() * 0.3
  return Math.min(MAX_DELAY_MS, Math.round((baseMs + typed) * jitter))
}

/** 中文与英文的句子结束符。换行也当断句，写代码块的人习惯那样分。 */
const SENTENCE_END = /(?<=[。！？!?…；;\n])/

/**
 * 把一段话切成几条。
 *
 * 只在真的长的时候切，且最多 maxChunks 条 —— 连发五条比一大段更烦人。
 */
export function splitReply(text: string, maxChunks: number = 3): string[] {
  const clean = text.trim()
  if (clean === '' || maxChunks <= 1) return clean === '' ? [] : [clean]

  const sentences = clean
    .split(SENTENCE_END)
    .map((one) => one.trim())
    .filter((one) => one !== '')
  if (sentences.length <= 1) return [clean]

  // 按句子数均分，尽量每段差不多长。
  const per = Math.ceil(sentences.length / maxChunks)
  const chunks: string[] = []
  for (let index = 0; index < sentences.length; index += per) {
    chunks.push(sentences.slice(index, index + per).join(''))
  }
  return chunks.slice(0, maxChunks)
}
