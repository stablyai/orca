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

import { execSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import os from 'os'

/** Temp file where the test repo path is stored for the fixture to read. */
export const TEST_REPO_PATH_FILE = path.join(os.tmpdir(), 'orca-e2e-test-repo-path.txt')

export default function globalSetup(): void {
  const root = process.cwd()
  const outMain = path.join(root, 'out', 'main', 'index.js')

  // ── 1. Build the Electron app ──────────────────────────────────────
  if (process.env.SKIP_BUILD && existsSync(outMain)) {
    console.log('[e2e] SKIP_BUILD set and out/main/index.js exists — skipping build')
  } else {
    // Why: --mode e2e loads .env.e2e which sets VITE_EXPOSE_STORE=true. This
    // makes window.__store available in the renderer build so tests can read
    // Zustand state directly instead of fragile DOM scraping.
    console.log('[e2e] Building Electron app with electron-vite build --mode e2e...')
    execSync('npx electron-vite build --mode e2e', {
      cwd: root,
      stdio: 'inherit',
      timeout: 120_000,
    })
    console.log('[e2e] Build complete.')
  }

  // ── 2. Create a seeded test git repo ───────────────────────────────
  // Why: each test run gets its own git repo so the suite is fully
  // idempotent. No test depends on whatever repos the user has open.
  const testRepoDir = path.join(os.tmpdir(), `orca-e2e-repo-${Date.now()}`)
  mkdirSync(testRepoDir, { recursive: true })

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
  writeFileSync(
    path.join(testRepoDir, 'src', 'index.ts'),
    // mkdirSync for src/ first
    (() => {
      mkdirSync(path.join(testRepoDir, 'src'), { recursive: true })
      return 'export const hello = "world"\n'
    })()
  )

  execSync('git add -A', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git commit -m "Initial commit for E2E tests"', { cwd: testRepoDir, stdio: 'pipe' })

  // Why: several tests verify worktree-switching behavior (terminal content
  // retention, browser tab retention). They need at least 2 worktrees.
  // Creating one here makes those tests run instead of being skipped.
  const worktreeDir = path.join(testRepoDir, '..', `orca-e2e-worktree-${Date.now()}`)
  execSync(`git worktree add "${worktreeDir}" -b e2e-secondary`, {
    cwd: testRepoDir,
    stdio: 'pipe',
  })
  console.log(`[e2e] Secondary worktree created at ${worktreeDir}`)

  // Write the test repo path so the fixture can read it
  writeFileSync(TEST_REPO_PATH_FILE, testRepoDir)
  console.log(`[e2e] Test repo created at ${testRepoDir}`)
}
