import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// 同梱の Chromium（バージョンが Playwright の期待と違うことがあるので明示的に指す）
const CHROMIUM = '/opt/pw-browsers/chromium'

/**
 * プリインストール済みの Chromium を使う。`playwright install` は実行しない。
 * ヘッドレス環境では GPU が無いため SwiftShader で WebGL を動かす。
 */
export default defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 960, height: 540 },
    launchOptions: {
      ...(existsSync(CHROMIUM) ? { executablePath: CHROMIUM } : {}),
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
