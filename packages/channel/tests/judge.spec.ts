import { describe, expect, it } from 'vitest'
import { askJev, jevRequest, readJevAnswer } from '../lib/judge.js'

/**
 * 破损类：**判错了还看不出来** —— 该来的时候不来，不该来的时候插一句。
 */
describe('JEV 判官', () => {
  it('请求带一个 choice 问题，五个选项各有判据', () => {
    const body = jevRequest('老王：这个报错怎么修') as any
    expect(body.model).toBe('jev-latest')
    expect(body.state).toContain('报错')
    expect(body.questions.attention.type).toBe('choice')
    expect(Object.keys(body.questions.attention.criteria)).toEqual([
      'asks_question',
      'substantive',
      'greeting',
      'noise',
      'private_talk',
    ])
  })

  it('选中的选项就是理由，不用再解释一遍', () => {
    const verdict = readJevAnswer({
      answers: { attention: { type: 'choice', choice: 'asks_question', confidence: 0.93 } },
    })
    expect(verdict.look).toBe(true)
    expect(verdict.reason).toBe('有人在问问题')
    expect(verdict.confidence).toBe(0.93)
  })

  it('「不值得」的档位也是理由', () => {
    const verdict = readJevAnswer({ answers: { attention: { choice: 'greeting', confidence: 0.1 } } })
    expect(verdict.look).toBe(false)
    expect(verdict.reason).toBe('只是打招呼')
  })

  it('认不出的选项当「不看」：判官失手时沉默比插话便宜', () => {
    expect(readJevAnswer({ answers: { attention: { choice: '???', confidence: 0.5 } } }).look).toBe(false)
    expect(readJevAnswer({}).look).toBe(false)
    expect(readJevAnswer(undefined).look).toBe(false)
  })

  it('发出去的是 POST + Bearer，地址拼对', async () => {
    let seen: { url: string; init: any } | undefined
    const verdict = await askJev({
      state: '在吗',
      baseUrl: 'https://api.typesafe.ai/',
      apiKey: 'k-1',
      fetchImpl: (async (url: any, init: any) => {
        seen = { url: String(url), init }
        return { ok: true, json: async () => ({ answers: { attention: { choice: 'greeting' } } }) } as any
      }) as any,
    })
    expect(seen?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(seen?.init.method).toBe('POST')
    expect(seen?.init.headers.authorization).toBe('Bearer k-1')
    expect(verdict.look).toBe(false)
  })

  it('接口报错要抛出，让调用方决定退路', async () => {
    await expect(
      askJev({
        state: 'x',
        baseUrl: 'https://api.typesafe.ai',
        apiKey: 'k',
        fetchImpl: (async () => ({ ok: false, status: 401, text: async () => 'no key' })) as any,
      }),
    ).rejects.toThrow(/401/)
  })
})
