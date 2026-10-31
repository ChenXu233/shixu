import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试跑 dist：装载器真正加载的就是构建产物，测它才有意义。
    include: ['packages/*/tests/**/*.spec.ts'],
    environment: 'node',
  },
})
