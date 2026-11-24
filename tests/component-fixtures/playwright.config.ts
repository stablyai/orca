import { defineConfig } from '@playwright/test'

// ORCA_BACKGROUND_LAUNCH=1 pnpm exec playwright test --config tests/component-fixtures/playwright.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:5197',
    headless: true,
    viewport: { width: 1000, height: 720 },
    reducedMotion: 'reduce',
    launchOptions: process.env.ORCA_FIXTURES_BROWSER
      ? { executablePath: process.env.ORCA_FIXTURES_BROWSER }
      : undefined,
    trace: 'retain-on-failure'
  },
  webServer: {
    command:
      'pnpm exec vite --config config/vite.fixtures.config.ts --host 127.0.0.1 --port 5197 --strictPort',
    cwd: '../..',
    url: 'http://127.0.0.1:5197/fixtures.html',
    timeout: 120_000
  }
})
