import { describe, expect, it } from 'vitest'
import { ACTION_API, fromOneBotMessage, normalize, renderText, toOneBotMessage } from '../dist/protocol.js'

/**
 * 只验证必要的正确性：消息落到哪个会话、模型读到什么、发出去变成什么。
 * 不认识的报文怎么处理这类分支，靠代码本身的「返回 undefined」就够，不额外测。
 */

describe('入站', () => {
  it('群消息落进群会话，发送者是发言人', () => {
    const event = normalize(
      {
        post_type: 'message',
        time: 1_700_000_000,
        self_id: 10000,
        message_type: 'group',
        sub_type: 'normal',
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
    expect(event?.detailType).toBe('group')
    expect(event?.conversationId).toBe('222')
    expect(event?.userId).toBe('333')
    expect(event?.messageId).toBe('7')
    expect(event?.self).toEqual({ platform: 'qq', accountId: '10000' })
    expect(event?.timestamp).toBe(1_700_000_000_000)
    expect(event?.text).toBe('@10000 在吗')
  })

  it('私聊的会话 id 是对方，不是自己', () => {
    const event = normalize(
      {
        post_type: 'message',
        time: 1,
        self_id: 10000,
        message_type: 'private',
        message_id: 8,
        user_id: 444,
        message: '你好',
      },
      'qq',
    )

    expect(event?.detailType).toBe('private')
    expect(event?.conversationId).toBe('444')
    expect(event?.text).toBe('你好')
  })

  it('心跳丢掉，其它 meta 事件照常上报', () => {
    expect(normalize({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 1 }, 'qq')).toBeUndefined()
    expect(normalize({ post_type: 'meta_event', meta_event_type: 'lifecycle', self_id: 1 }, 'qq')?.type).toBe('meta')
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
    expect(toOneBotMessage([{ type: 'card', data: {}, native }])).toEqual([native])
  })

  it('动作参数把字符串 id 转成数字，否则平台静默失败', () => {
    expect(ACTION_API.ban?.build({ groupId: '222', userId: '333', durationSeconds: 60 })).toEqual({
      group_id: 222,
      user_id: 333,
      duration: 60,
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
