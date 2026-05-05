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
  // Why: the headless Electron specs launch isolated app instances and can
  // safely fan out across workers, which cuts the default E2E runtime
  // substantially. The few visible-window tests that still rely on real
  // pointer interaction are marked serial in their spec file instead.
  fullyParallel: true,
  // Why: Playwright defaults to workers=1 on CI, which would serialize all
  // specs on the ubuntu-latest runner (4 vCPUs) and waste headroom. Each test
  // launches an isolated Electron instance with its own userData dir, so they
  // don't share state — we can safely fan out to match the runner's vCPU count.
  workers: process.env.CI ? 4 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    // Why: this suite intentionally runs with retries disabled so first-failure
    // traces are the only reliable debugging artifact we can collect in CI.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'electron-headless',
      testMatch: '**/*.spec.ts',
      grepInvert: /@headful/,
      metadata: {
        orcaHeadful: false
      }
    },
    {
      name: 'electron-headful',
      testMatch: '**/*.spec.ts',
      grep: /@headful/,
      metadata: {
        orcaHeadful: true
      }
    }
  ]
})
