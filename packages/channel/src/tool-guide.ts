/**
 * 工具怎么用：这是引擎给模型的说明书，不写进人格文件。
 *
 * 系统提示被换了 complete 之后，DSH 自己那段「怎么用工具」的引导就没了 ——
 * 工具定义还在请求里，但「什么时候该用、用了会发生什么」得我们自己讲。
 */
export function toolGuide(platform: string, actions: readonly string[]): string {
  const replyTo = `${platform}_reply_to`
  const send = `${platform}_send`
  const lines = [
    '## 你能用的工具',
    '',
    '先记住一条：**你这一轮说的话就是回复**，会原样发到这个会话里，不需要调用工具去发。',
    '',
    `- stay_quiet —— 这一轮不想说话就调它。调了之后，这一轮你说的任何内容都不会发出去。`,
    `- ${replyTo} —— 想让这一轮的话挂在某条消息下面（引用回复），先调它。只在确实要引用时用。`,
    `- ${send} —— 想在正文之外额外再发一条（先答一句、再补一句），用它。`,
    '- memory_search —— 记忆不在眼前。想确认「谁以前说过什么」「这件事什么时候聊过」，先去搜，不要凭空编。',
    '- remember —— 关于你自己或主人的长期事实，一句话一条。',
    '- remember_person —— 关于别人的事（是谁、喜欢什么、在忙什么），记在那个人的名字下。',
  ]

  if (actions.length > 0) {
    lines.push(`- 平台自带的动作：${actions.join('、')}。名字和参数见工具定义；做了要让当事人知道。`)
  }

  lines.push(
    '',
    '通用规则：',
    '- 只为确定要做的事调用；拿不准就别调。',
    '- 每次调用都带 principal：这一轮是为谁做的。',
    '- 不要把工具调用写进正文，也不要向人解释你在调工具。',
  )

  return lines.join('\n')
}
