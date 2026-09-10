import { defineConfig } from '@stablyai/playwright-test'

process.env.ORCA_BACKGROUND_LAUNCH = '1'

// This diagnostic owns its profiles and builds explicitly; no global CLI installation or SSH setup.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'paired-remote-terminal-replacement-state.spec.ts',
  timeout: 420_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '../test-results/remote-replacement',
  use: { trace: 'retain-on-failure' }
})
