import { describe, expect, it } from 'vitest'
import { visitBrief } from '../lib/brief.js'
import { Budget } from '../lib/budget.js'

/**
 * 破损类一：**它醒过来却不知道自己在哪、在跟谁说话**。
 * 用户看到：它接了一句完全不搭的话，或者对着一小时前的消息作答。
 */
describe('醒来时看到的那段话', () => {
  it('带上场所、安静了多久、最近几条（带 id）', () => {
    const brief = visitBrief({
      venueLabel: 'qq 615374518',
      quietForMs: 42 * 60_000,
      messages: [
        { id: 'm-1', name: '小明', subject: 'u1', text: '今天好热', images: 0 },
        { id: 'm-2', subject: 'u2', text: '', images: 1 },
      ],
    })

    expect(brief).toContain('qq 615374518')
    expect(brief).toContain('42 分钟')
    expect(brief).toContain('[m-1] 小明：今天好热')
    expect(brief).toContain('[m-2] u2：[图片]')
    // 它得有「可以不说」这个选项，否则每次醒来都必须说话。
    expect(brief).toContain('不想说就只回一个 -')
  })

  it('刚聊完的场所不说「没人说话」', () => {
    const brief = visitBrief({ venueLabel: 'qq g1', quietForMs: 5_000, messages: [] })
    expect(brief).not.toContain('没人说话')
    expect(brief).toContain('还没有消息')
  })
})

/**
 * 破损类二：**十个群同时热闹，十个请求一起跑、十条消息一起发**。
 * 用户看到：机器人刷屏，或者十分钟都没回你。
 */
describe('说话的配额', () => {
  it('同时在看的场所不超过上限', () => {
    const budget = new Budget(2, 8)
    expect(budget.tryEnter('a')).toBe(true)
    expect(budget.tryEnter('b')).toBe(true)
    expect(budget.tryEnter('c')).toBe(false)
    budget.leave('a')
    expect(budget.tryEnter('c')).toBe(true)
  })

  it('同一个场所不重复进', () => {
    const budget = new Budget(3, 8)
    expect(budget.tryEnter('a')).toBe(true)
    expect(budget.tryEnter('a')).toBe(false)
  })

  it('一分钟说满了就不再说，过了窗口又能说', () => {
    const budget = new Budget(3, 2, 60_000)
    expect(budget.allowSpeak(0)).toBe(true)
    budget.noteSpoke(0)
    budget.noteSpoke(1_000)
    expect(budget.allowSpeak(2_000)).toBe(false)
    expect(budget.allowSpeak(61_000)).toBe(true)
  })
})
