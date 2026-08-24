import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // *.spec.ts は Playwright 用なので除外する
    include: ['test/**/*.test.ts'],
  },
})
