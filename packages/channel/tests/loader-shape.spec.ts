import { describe, expect, it } from 'vitest'

/**
 * 破损类：**装载器眼里的插件与作者以为的不是同一个**。
 *
 * 实测 cordis-plugin-loader 的 unwrapExports：
 *   exports = exports.default ?? exports
 * 也就是说模块一旦有 default 导出，所有命名导出（包括 inject）就被整体丢弃。
 * 用户看到：插件照常启动，但它不依赖任何服务、也不在正确的时机激活 ——
 * 上游为此写过一篇事故复盘（acp-default-export-drops-inject）。
 *
 * 所以这里断言的不是「代码风格」，而是**装载器最终拿到的东西仍然带着 inject**。
 */
function unwrapExports(exports: any) {
  if (exports === null || exports === undefined) return exports
  exports = exports.default ?? exports
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}

describe('插件入口在装载器眼里必须完好', () => {
  it('driver-fake：装载后仍带着 inject 与 apply', async () => {
    const plugin = unwrapExports(await import('../dist/driver-fake.js')) as any
    expect(plugin.inject).toEqual(['channels'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.name).toBe('driver-fake')
  })

  it('binding：装载后仍带着 inject 与 apply', async () => {
    const plugin = unwrapExports(await import('../dist/binding.js')) as any
    expect(plugin.inject).toEqual(['channels'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('channels：默认导出是 Service 子类（自带生命周期）', async () => {
    const plugin = unwrapExports(await import('../dist/channels.js')) as any
    expect(typeof plugin).toBe('function')
    expect(plugin.name).toBe('Channels')
  })

  it('守卫本身有效：一个有 default 的模块确实会丢掉 inject', () => {
    const regressed = {
      name: 'some-plugin',
      inject: ['channels'],
      apply() {},
      default: function apply() {},
    }
    expect((unwrapExports(regressed) as any).inject).toBeUndefined()
  })
})
