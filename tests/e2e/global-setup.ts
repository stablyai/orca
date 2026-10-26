// Build current E2E output and create an isolated fixture repo whose path is shared with workers.

import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { prepareDockerSshHostImage } from './helpers/docker-ssh-host-image'

export const E2E_TEST_REPO_PATH_FILE_ENV = 'ORCA_E2E_TEST_REPO_PATH_FILE'
const RUN_TEST_REPO_PATH_FILE =
  process.env[E2E_TEST_REPO_PATH_FILE_ENV] ??
  path.join(os.tmpdir(), `orca-e2e-test-repo-path-${randomUUID()}.txt`)

export function workerTestRepositoryPathFile(runPathFile: string, workerIndex?: string): string {
  if (workerIndex === undefined) {
    return runPathFile
  }
  if (!/^\d+$/.test(workerIndex)) {
    throw new Error('Invalid Playwright worker index')
  }
  return `${runPathFile}.worker-${workerIndex}`
}

// Restart helpers and the app fixture must read the same worker-owned repository.
export const TEST_REPO_PATH_FILE = workerTestRepositoryPathFile(
  RUN_TEST_REPO_PATH_FILE,
  process.env.TEST_WORKER_INDEX
)
const ELECTRON_E2E_BUILD_TIMEOUT_MS = 300_000
const CLI_E2E_BUILD_TIMEOUT_MS = 120_000
const WEB_E2E_BUILD_TIMEOUT_MS = 300_000

export default function globalSetup(): void {
  // Why: workers and teardown need this run's path, never another concurrent run's.
  process.env[E2E_TEST_REPO_PATH_FILE_ENV] = TEST_REPO_PATH_FILE
  const root = process.cwd()
  const outMain = path.join(root, 'out', 'main', 'index.js')
  const outCli = path.join(root, 'out', 'cli', 'index.js')
  const outWeb = path.join(root, 'out', 'web', 'web-index.html')

  if (process.env.SKIP_BUILD && existsSync(outMain)) {
    console.error('[e2e] SKIP_BUILD set and out/main/index.js exists — skipping build')
  } else {
    // Use E2E mode to expose window.__store; retain the env flag for older local overrides.
    console.error('[e2e] Building Electron app with electron-vite build --mode e2e...')
    execSync('npx electron-vite build --mode e2e', {
      env: { ...process.env, VITE_EXPOSE_STORE: 'true' },
      cwd: root,
      stdio: 'inherit',
      // Allow healthy Windows renderer builds to outlast 120s before specs start.
      timeout: ELECTRON_E2E_BUILD_TIMEOUT_MS
    })
    console.error('[e2e] Build complete.')
  }
  if (process.env.SKIP_BUILD && existsSync(outCli)) {
    console.error('[e2e] SKIP_BUILD set and out/cli/index.js exists — skipping CLI build')
    // Artifact downloads lose executable bits; each runner still needs its local dev launcher.
    execSync('pnpm run prepare:cli-output', {
      cwd: root,
      stdio: 'inherit',
      timeout: CLI_E2E_BUILD_TIMEOUT_MS
    })
  } else {
    console.error('[e2e] Building bundled CLI...')
    execSync('pnpm run build:cli', {
      cwd: root,
      stdio: 'inherit',
      timeout: CLI_E2E_BUILD_TIMEOUT_MS
    })
    console.error('[e2e] CLI build complete.')
  }
  if (process.env.ORCA_E2E_WEB_CLIENT === '1') {
    if (process.env.SKIP_BUILD && existsSync(outWeb)) {
      console.error('[e2e] SKIP_BUILD set and web client exists — skipping web build')
    } else {
      // Why: paired-browser specs need the web bundle served by the runtime; ordinary Electron E2E does not.
      console.error('[e2e] Building paired runtime web client...')
      execSync('pnpm run build:web', {
        env: { ...process.env, VITE_EXPOSE_STORE: 'true' },
        cwd: root,
        stdio: 'inherit',
        timeout: WEB_E2E_BUILD_TIMEOUT_MS
      })
      console.error('[e2e] Web client build complete.')
    }
  }
  if (process.env.ORCA_E2E_SSH_DOCKER === '1') {
    console.error('[e2e] Preparing Docker OpenSSH fixture image...')
    prepareDockerSshHostImage(root)
  }

  // Resolve macOS /var symlinks like git does when registering repo.path.
  const testRepoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-repo-')))

  execSync('git init', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git config user.email "e2e@test.local"', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git config user.name "E2E Test"', { cwd: testRepoDir, stdio: 'pipe' })

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
  writeFileSync(path.join(testRepoDir, 'src', 'diff-note-layout.ts'), 'export const seed = true\n')

  execSync('git add -A', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git commit -m "Initial commit for E2E tests"', { cwd: testRepoDir, stdio: 'pipe' })

  // Seed a second worktree so retention/switching specs run instead of skipping.
  const worktreeDir = path.join(testRepoDir, '..', `orca-e2e-worktree-${randomUUID()}`)
  execSync(`git worktree add "${worktreeDir}" -b e2e-secondary`, {
    cwd: testRepoDir,
    stdio: 'pipe'
  })
  console.error(`[e2e] Secondary worktree created at ${worktreeDir}`)

  writeFileSync(TEST_REPO_PATH_FILE, testRepoDir)
  console.error(`[e2e] Test repo created at ${testRepoDir}`)
}
