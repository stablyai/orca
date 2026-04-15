import { defineConfig } from '@stablyai/playwright-test'

/**
 * Playwright config for Orca E2E tests.
 *
 * Run:
 *   pnpm run test:e2e              — build + run all tests (headless)
 *   pnpm run test:e2e:headful      — run with visible window (for pointer-capture tests)
 *   SKIP_BUILD=1 pnpm run test:e2e — skip rebuild (faster iteration)
 *
 * globalSetup builds the Electron app and creates a seeded test git repo.
 * globalTeardown cleans up the test repo.
 * Tests use _electron.launch() to start the app — no manual setup needed.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Why: this suite launches a fresh Electron app and isolated userData dir per
  // test. Cold-starts late in the run can exceed 60s on CI even when the app is
  // healthy, so the per-test budget needs to cover startup plus assertions.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  /* Run tests serially to keep the Electron E2E suite predictable */
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'electron-headless',
      testMatch: '**/*.spec.ts',
      grepInvert: /@headful/,
      metadata: {
        orcaHeadful: false,
      },
    },
    {
      name: 'electron-headful',
      testMatch: '**/*.spec.ts',
      grep: /@headful/,
      metadata: {
        orcaHeadful: true,
      },
    },
  ],
})
