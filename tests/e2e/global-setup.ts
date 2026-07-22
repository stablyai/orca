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

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Temp file where the test repo path is stored for the fixture to read. */
export const TEST_REPO_PATH_FILE = path.join(os.tmpdir(), 'orca-e2e-test-repo-path.txt')
const ELECTRON_E2E_BUILD_TIMEOUT_MS = 300_000
const WEB_E2E_BUILD_TIMEOUT_MS = 300_000

export default function globalSetup(): void {
  const root = process.cwd()
  const outMain = path.join(root, 'out', 'main', 'index.js')
  const outWeb = path.join(root, 'out', 'web', 'web-index.html')

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
  if (process.env.ORCA_E2E_WEB_CLIENT === '1') {
    if (process.env.SKIP_BUILD && existsSync(outWeb)) {
      console.error('[e2e] SKIP_BUILD set and web client exists — skipping web build')
    } else {
      // Why: paired-browser specs need the web bundle served by the runtime; ordinary Electron E2E does not.
      console.error('[e2e] Building paired runtime web client...')
      execSync('pnpm run build:web', {
        cwd: root,
        stdio: 'inherit',
        timeout: WEB_E2E_BUILD_TIMEOUT_MS
      })
      console.error('[e2e] Web client build complete.')
    }
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
  // Why: realpathSync so the seeded path matches the store's repo.path on
  // macOS, where os.tmpdir() (/var/...) symlinks to /private/var/... and the
  // app canonicalizes repo.path via `git rev-parse --show-toplevel` on add.
  const testRepoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-repo-')))

  execSync('git init', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git config user.email "e2e@test.local"', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git config user.name "E2E Test"', { cwd: testRepoDir, stdio: 'pipe' })

  // Seed test data files
  writeFileSync(
    path.join(testRepoDir, 'README.md'),
    '# Orca E2E Test Repo\n\nThis repo was created automatically for Playwright tests.\n'
  )
  writeFileSync(path.join(testRepoDir, 'CLAUDE.md'), '# CLAUDE.md\n\nTest instructions for E2E.\n')
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
  const worktreeDir = path.join(testRepoDir, '..', `orca-e2e-worktree-${randomUUID()}`)
  execSync(`git worktree add "${worktreeDir}" -b e2e-secondary`, {
    cwd: testRepoDir,
    stdio: 'pipe'
  })
  console.error(`[e2e] Secondary worktree created at ${worktreeDir}`)

  // Write the test repo path so the fixture can read it
  writeFileSync(TEST_REPO_PATH_FILE, testRepoDir)
  console.error(`[e2e] Test repo created at ${testRepoDir}`)
}
