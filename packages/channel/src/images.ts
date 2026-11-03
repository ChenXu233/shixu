/**
 * 图片：从平台给的地址把字节取回来。
 *
 * 模型有识图能力，但前提是它拿到的是一张图，而不是一个 `[image]` 字样。
 * 这一步只负责「取回并认出格式」，落库交给 `ctx.attachments`。
 */

/** 单张图片的字节上限。超过就当成没收到，不要用它撑爆上下文。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export interface EncodedImage {
  /** canonical base64 */
  data: string
  mediaType: string
}

type Fetcher = (url: string) => Promise<{
  ok: boolean
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}>

/** 按魔数认图片类型。平台给的后缀不可信，字节才是真的。 */
export function imageMediaType(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...values: number[]): boolean =>
    bytes.length >= offset + values.length && values.every((value, index) => bytes[offset + index] === value)

  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return undefined
}

/**
 * 取一张图。取不到、太大、不是图片，都返回 undefined ——
 * 一张图坏了不该让整条消息丢掉。
 */
export async function fetchImage(
  url: string,
  fetchImpl: Fetcher = fetch as unknown as Fetcher,
  limitBytes: number = MAX_IMAGE_BYTES,
): Promise<EncodedImage | undefined> {
  if (url === '') return undefined
  const response = await fetchImpl(url)
  if (!response.ok) return undefined

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > limitBytes) return undefined

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > limitBytes) return undefined

  const mediaType = imageMediaType(bytes)
  if (mediaType === undefined) return undefined

  return { data: Buffer.from(bytes).toString('base64'), mediaType }
}
