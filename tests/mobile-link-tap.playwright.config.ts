import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './web',
  testMatch: 'mobile-link-tap.spec.ts',
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/mobile-link-tap-results.json' }]],
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:5183', trace: 'retain-on-failure' },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'streamed-chromium',
      testMatch: 'streamed-browser-link-tap.spec.ts',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' }
    }
  ],
  webServer: {
    command: 'node tests/web/fixtures/mobile-link-tap/serve.mjs',
    cwd: '..',
    url: 'http://127.0.0.1:5183/tests/web/fixtures/mobile-link-tap/index.html',
    env: { ORCA_BACKGROUND_LAUNCH: '1' },
    timeout: 60_000
  }
})
