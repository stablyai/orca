import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { defineConfig } from '@stablyai/playwright-test'

// ORCA_BACKGROUND_LAUNCH=1 ORCA_ROW_MENU_HEAD="$(git rev-parse HEAD)" pnpm exec playwright test --config tests/tools/agent-row-menu/proof.config.ts
assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
assert.equal(Boolean(process.env.SKIP_BUILD), false)
assert.equal(
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  process.env.ORCA_ROW_MENU_HEAD
)
assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '')

export default defineConfig({
  testMatch: 'row-actions.spec.ts',
  globalSetup: '../../e2e/global-setup.ts',
  globalTeardown: '../../e2e/global-teardown.ts',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: process.env.ORCA_ROW_MENU_EVIDENCE_DIR ?? '../../../test-results/agent-row-menu',
  captureGitInfo: { commit: false, diff: false }
})
