/**
 * Seeded git repo for Orca E2E fixtures: creation and validity checks for the
 * disposable test repo (plus its secondary worktree) that specs operate on.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { TEST_REPO_PATH_FILE } from '../global-setup'

export function isValidGitRepo(repoPath: string): boolean {
  if (!repoPath || !existsSync(repoPath)) {
    return false
  }

  try {
    return (
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: repoPath,
        stdio: 'pipe',
        encoding: 'utf8'
      }).trim() === 'true'
    )
  } catch {
    return false
  }
}

export function createSeededTestRepo(): string {
  // Why: realpathSync so the seeded path matches the store's repo.path on
  // macOS, where os.tmpdir() (/var/...) symlinks to /private/var/... and the
  // app canonicalizes repo.path via `git rev-parse --show-toplevel` on add.
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

  execSync('git add -A', { cwd: testRepoDir, stdio: 'pipe' })
  execSync('git commit -m "Initial commit for E2E tests"', { cwd: testRepoDir, stdio: 'pipe' })

  // Why: worker-scoped fixture fallbacks can run in parallel; UUIDs avoid
  // colliding on the same temp repo/worktree when workers start together.
  const worktreeDir = path.join(testRepoDir, '..', `orca-e2e-worktree-${randomUUID()}`)
  execSync(`git worktree add "${worktreeDir}" -b e2e-secondary`, {
    cwd: testRepoDir,
    stdio: 'pipe'
  })

  writeFileSync(TEST_REPO_PATH_FILE, testRepoDir)
  return testRepoDir
}
