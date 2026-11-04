import { defineConfig } from '@stablyai/playwright-test'
import { resolveBuildSourceCommit } from '../config/scripts/build-source-commit.mjs'

// Run ORCA_BACKGROUND_LAUNCH=1 pnpm run test:e2e to build/run; SKIP_BUILD=1 reuses the current E2E build.
// Headful pointer-capture runs require an isolated display. Global setup/teardown own the seeded repo; fixtures launch Electron.
export default defineConfig({
  testDir: './e2e',
  // Keep checkout provenance without fetching the PR base during test setup.
  captureGitInfo: { commit: false, diff: false },
  metadata: { sourceCommit: resolveBuildSourceCommit() },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Budget startup plus assertions: fresh app/profile launches can exceed 60s late in CI.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // Isolated hidden apps can fan out; visible-window pointer specs serialize themselves.
  fullyParallel: true,
  // CI scales by shards: two real Electron trees per VM contended on Xvfb/git and caused false failures.
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    // Disable retries so CI retains the first failure’s reliable trace.
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
