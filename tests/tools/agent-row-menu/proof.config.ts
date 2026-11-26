import { join } from 'node:path'
import { defineConfig } from '@stablyai/playwright-test'
import { assertFrozenSource, evidenceDir } from './proof-build-inputs'

assertFrozenSource()

export default defineConfig({
  testMatch: 'row-actions.spec.ts',
  globalSetup: './proof-setup.ts',
  globalTeardown: '../../e2e/global-teardown.ts',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [
    ['list', { printSteps: true }],
    ['json', { outputFile: join(evidenceDir, 'results.json') }]
  ],
  outputDir: evidenceDir,
  captureGitInfo: { commit: false, diff: false }
})
