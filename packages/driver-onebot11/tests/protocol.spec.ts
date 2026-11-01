import { describe, expect, it } from 'vitest'
import { ACTION_API, ACTIONS, normalize, renderText, toOneBotMessage } from '../dist/protocol.js'

/**
 * 只验证必要的正确性：消息落到哪个会话、模型读到什么、发出去变成什么、
 * 哪些协议词汇不许漏出来。
 */

describe('入站：一条消息', () => {
  it('群消息落进群会话，发言人带名字，不是机器人自己', () => {
    const event = normalize(
      {
        post_type: 'message',
        time: 1_700_000_000,
        self_id: 10000,
        message_type: 'group',
        message_id: 7,
        group_id: 222,
        user_id: 333,
        sender: { user_id: 333, nickname: '小明' },
        message: [
          { type: 'at', data: { qq: '10000' } },
          { type: 'text', data: { text: ' 在吗' } },
        ],
      },
      'qq',
    )

    expect(event?.type).toBe('message')
    expect(event?.conversationType).toBe('group')
    expect(event?.venue).toEqual({ platform: 'qq', accountId: '10000', conversationId: '222' })
    expect(event?.actor).toEqual({ id: '333', name: '小明' })
    expect(event?.self).toBe(false)
    expect(event?.messageId).toBe('7')
    expect(event?.timestamp).toBe(1_700_000_000_000)
    expect(event?.text).toBe('@10000 在吗')
  })

  it('私聊的会话 id 是对方；机器人自己发的消息标 self', () => {
    const event = normalize(
      {
        post_type: 'message_sent',
        time: 1,
        self_id: 10000,
        message_type: 'private',
        message_id: 8,
        user_id: 10000,
        message: '我在',
      },
      'qq',
    )

    expect(event?.conversationType).toBe('private')
    expect(event?.venue.conversationId).toBe('10000')
    expect(event?.self).toBe(true)
    expect(event?.text).toBe('我在')
  })
})

describe('入站：场所里的人变了', () => {
  it('入群、退群、被踢、升管理员、撤管理员各归各位', () => {
    const base = { post_type: 'notice', time: 1, self_id: 10000, group_id: 222, user_id: 333 }
    expect(normalize({ ...base, notice_type: 'group_increase' }, 'qq')?.change).toBe('join')
    expect(normalize({ ...base, notice_type: 'group_decrease', sub_type: 'leave' }, 'qq')?.change).toBe('leave')
    expect(normalize({ ...base, notice_type: 'group_decrease', sub_type: 'kick' }, 'qq')?.change).toBe('kick')
    expect(normalize({ ...base, notice_type: 'group_admin', sub_type: 'set' }, 'qq')?.change).toBe('promote')
    expect(normalize({ ...base, notice_type: 'group_admin', sub_type: 'unset' }, 'qq')?.change).toBe('demote')
  })

  it('不认识的通知、心跳、申请一律不进统一事件', () => {
    expect(normalize({ post_type: 'notice', notice_type: 'group_upload', self_id: 1 }, 'qq')).toBeUndefined()
    expect(normalize({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 1 }, 'qq')).toBeUndefined()
    expect(normalize({ post_type: 'request', request_type: 'group', self_id: 1 }, 'qq')).toBeUndefined()
  })
})

describe('协议词汇不外泄', () => {
  it('表情、卡片、合并转发都变成 unknown，只有 label 给模型看', () => {
    const event = normalize(
      {
        post_type: 'message',
        time: 1,
        self_id: 10000,
        message_type: 'group',
        message_id: 9,
        group_id: 222,
        user_id: 333,
        message: [
          { type: 'face', data: { id: '14' } },
          { type: 'json', data: { data: '{}' } },
          { type: 'forward', data: { id: 'abc' } },
        ],
      },
      'qq',
    )

    expect(event?.message?.map((s) => s.type)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(event?.text).toBe('[表情][卡片][合并转发]')
  })
})

describe('出站', () => {
  it('统一段换成 OneBot 段', () => {
    expect(
      toOneBotMessage([
        { type: 'mention', data: { userId: '10000' } },
        { type: 'text', data: { text: ' 好' } },
        { type: 'quote', data: { messageId: '7' } },
        { type: 'image', data: { url: 'https://example.com/a.png' } },
      ]),
    ).toEqual([
      { type: 'at', data: { qq: '10000' } },
      { type: 'text', data: { text: ' 好' } },
      { type: 'reply', data: { id: '7' } },
      { type: 'image', data: { file: 'https://example.com/a.png' } },
    ])
  })

  it('native 优先：驱动认得的东西不再解释一遍', () => {
    const native = { type: 'json', data: { data: '{"app":"x"}' } }
    expect(toOneBotMessage([{ type: 'unknown', data: {}, native }])).toEqual([native])
  })
})

describe('动作目录', () => {
  it('名字是平台无关的词，参数把字符串 id 转成数字', () => {
    expect(ACTIONS.map((a) => a.name)).toEqual([
      'member_list',
      'member_info',
      'recall',
      'mute',
      'kick',
      'set_role',
      'approve_join',
      'leave',
    ])
    expect(ACTION_API.mute?.build({ groupId: '222', userId: '333', durationSeconds: 60 })).toEqual({
      group_id: 222,
      user_id: 333,
      duration: 60,
    })
    expect(ACTION_API.set_role?.build({ groupId: '222', userId: '333', role: 'admin' })).toEqual({
      group_id: 222,
      user_id: 333,
      enable: true,
    })
  })
})

describe('文本渲染', () => {
  it('把段拼成模型能读的一句话', () => {
    expect(
      renderText([
        { type: 'quote', data: { messageId: '1' } },
        { type: 'mentionAll', data: {} },
        { type: 'text', data: { text: ' 开会' } },
        { type: 'image', data: {} },
      ]),
    ).toBe('@全体成员 开会[image]')
  })
})
