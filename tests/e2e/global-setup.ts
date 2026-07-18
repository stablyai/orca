/**
 * Playwright globalSetup: builds the Electron app and creates a test git repo.
 *
 * Why: _electron.launch() needs the compiled output in out/main/index.js.
 * Running electron-vite build here ensures the tests are always against
 * the current source, without requiring the user to remember a manual step.
 *
 * Why: a dedicated test repo makes the suite idempotent — tests don't
 * depend on whatever the user has open. The repo path is written to a
 * temp file so the worker fixture can pick it up at runtime.
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  cleanupE2ERunScope,
  readPreparedE2ERunResources,
  resolveE2ERunScope
} from './e2e-run-scope'

export const E2E_RUN_SCOPE = resolveE2ERunScope()
/** Run-scoped temp file where the test repo path is stored for workers. */
export const TEST_REPO_PATH_FILE = E2E_RUN_SCOPE.repoPathFile
const ELECTRON_E2E_BUILD_TIMEOUT_MS = 300_000

export default function globalSetup(): void {
  const root = process.cwd()
  const outMain = path.join(root, 'out', 'main', 'index.js')
  const { testRepoDir, worktreeDir } = readPreparedE2ERunResources(E2E_RUN_SCOPE)

  // ── 1. Build the Electron app ──────────────────────────────────────
  if (process.env.SKIP_BUILD && existsSync(outMain)) {
    console.error('[e2e] SKIP_BUILD set and out/main/index.js exists — skipping build')
  } else {
    // Why: --mode e2e is the build-time signal that exposes window.__store;
    // the explicit env var keeps older local overrides working too.
    console.error('[e2e] Building Electron app with electron-vite build --mode e2e...')
    execSync('npx electron-vite build --mode e2e', {
      env: { ...process.env, VITE_EXPOSE_STORE: 'true' },
      cwd: root,
      stdio: 'inherit',
      // Why: Windows renderer builds can exceed 120s on local/CI hosts even
      // when healthy; global setup should not fail before specs can run.
      timeout: ELECTRON_E2E_BUILD_TIMEOUT_MS
    })
    console.error('[e2e] Build complete.')
  }
  if (process.env.ORCA_E2E_SSH_LOCALHOST === '1' || process.env.ORCA_E2E_SSH_DOCKER === '1') {
    // Why: the SSH specs deploy Orca's relay from out/relay. The
    // normal Electron E2E build does not produce that bundle, so build it only
    // for explicit SSH runs.
    console.error('[e2e] Building SSH relay bundle for SSH E2E...')
    execSync('pnpm run build:relay', {
      cwd: root,
      stdio: 'inherit',
      timeout: 120_000
    })
  }

  // ── 2. Create a seeded test git repo ───────────────────────────────
  // Why: each test run gets its own git repo so the suite is fully
  // idempotent. No test depends on whatever repos the user has open.
  try {
    execSync('git init', { cwd: testRepoDir, stdio: 'pipe' })
    execSync('git config user.email "e2e@test.local"', { cwd: testRepoDir, stdio: 'pipe' })
    execSync('git config user.name "E2E Test"', { cwd: testRepoDir, stdio: 'pipe' })

    // Seed test data files
    writeFileSync(
      path.join(testRepoDir, 'README.md'),
      '# Orca E2E Test Repo\n\nThis repo was created automatically for Playwright tests.\n'
    )
    writeFileSync(
      path.join(testRepoDir, 'CLAUDE.md'),
      '# CLAUDE.md\n\nTest instructions for E2E.\n'
    )
    writeFileSync(
      path.join(testRepoDir, 'package.json'),
      `${JSON.stringify({ name: 'orca-e2e-test', version: '0.0.0', private: true }, null, 2)}\n`
    )
    writeFileSync(path.join(testRepoDir, '.gitignore'), 'node_modules/\n')
    mkdirSync(path.join(testRepoDir, 'src'), { recursive: true })
    writeFileSync(path.join(testRepoDir, 'src', 'index.ts'), 'export const hello = "world"\n')

    execSync('git add -A', { cwd: testRepoDir, stdio: 'pipe' })
    execSync('git commit -m "Initial commit for E2E tests"', { cwd: testRepoDir, stdio: 'pipe' })

    // Why: several tests verify worktree-switching behavior (terminal content
    // retention, browser tab retention). They need at least 2 worktrees.
    // Creating one here makes those tests run instead of being skipped.
    execFileSync('git', ['worktree', 'add', '-b', 'e2e-secondary', worktreeDir], {
      cwd: testRepoDir,
      stdio: 'pipe'
    })
    console.error(`[e2e] Secondary worktree created at ${worktreeDir}`)

    writeFileSync(TEST_REPO_PATH_FILE, testRepoDir)
    console.error(`[e2e] Test repo created at ${testRepoDir}`)
  } catch (error) {
    try {
      cleanupE2ERunScope(E2E_RUN_SCOPE)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'E2E setup and owned cleanup both failed')
    }
    throw error
  }
}
