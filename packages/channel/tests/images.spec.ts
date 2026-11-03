import { describe, expect, it } from 'vitest'
import { fetchImage, imageMediaType } from '../lib/images.js'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

/**
 * 破损类：**图片没进来，或者进来了一个不是图片的东西**。
 * 用户看到：发张图，人格说「图片」两个字；或者模型收到一段乱码。
 */
describe('认图片格式', () => {
  it('按字节认 jpeg / png / gif / webp', () => {
    expect(imageMediaType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg')
    expect(imageMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png')
    expect(imageMediaType(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif')
    expect(imageMediaType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp')
  })

  it('不是图片就认不出：不要把它塞给模型', () => {
    expect(imageMediaType(bytes(0x7b, 0x22, 0x61, 0x22))).toBeUndefined()
    expect(imageMediaType(bytes())).toBeUndefined()
  })
})

/** 一个假的下载器：按给定字节和状态码回应。 */
const reply = (payload: Uint8Array, init: { ok?: boolean; declared?: number } = {}) =>
  async () => ({
    ok: init.ok ?? true,
    headers: { get: (name: string) => (name === 'content-length' ? String(init.declared ?? payload.byteLength) : null) },
    arrayBuffer: async () => payload.slice().buffer,
  })

describe('取图片字节', () => {
  it('取回来变成 base64 + 类型', async () => {
    const image = await fetchImage('http://x/a.png', reply(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
    expect(image?.mediaType).toBe('image/png')
    expect(Buffer.from(image!.data, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('下载失败、空地址都不抛，返回 undefined', async () => {
    expect(await fetchImage('http://x/a.png', reply(bytes(1, 2), { ok: false }))).toBeUndefined()
    expect(await fetchImage('')).toBeUndefined()
  })

  it('太大就不收：声明的大小和实际大小都要看', async () => {
    const ok = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
    expect(await fetchImage('http://x/a.png', reply(ok, { declared: 9_999_999 }), 100)).toBeUndefined()
    expect(await fetchImage('http://x/a.png', reply(ok), 4)).toBeUndefined()
    expect(await fetchImage('http://x/a.png', reply(ok), 100)).toBeDefined()
  })

  it('不是图片就不收', async () => {
    expect(await fetchImage('http://x/a.png', reply(bytes(0x3c, 0x68, 0x74, 0x6d, 0x6c)))) .toBeUndefined()
  })
})
