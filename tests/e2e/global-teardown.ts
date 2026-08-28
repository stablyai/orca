/**
 * Playwright globalTeardown: cleans up the test git repo and worktrees.
 *
 * Why: the temp repo created by globalSetup should be removed after the
 * test run so we don't litter the user's /tmp with test directories.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { TEST_REPO_PATH_FILE } from './global-setup'

export function linkedWorktreePaths(testRepoDir: string): string[] {
  const root = realpathSync(testRepoDir)
  const output = execFileSync('git', ['-C', testRepoDir, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8'
  })
  const linked = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) {
      continue
    }
    const recordedPath = line.slice('worktree '.length)
    if (!existsSync(recordedPath)) {
      continue
    }
    const canonicalPath = realpathSync(recordedPath)
    if (canonicalPath !== root) {
      linked.add(canonicalPath)
    }
  }
  return [...linked]
}

export function cleanupTestRepository(testRepoDir: string): void {
  const root = realpathSync(testRepoDir)
  let worktreePaths: string[] = []
  try {
    worktreePaths = linkedWorktreePaths(root)
  } catch {
    // The isolated repo is still safe to remove when Git metadata is unreadable.
  }
  for (const worktreeDir of worktreePaths) {
    if (existsSync(worktreeDir)) {
      rmSync(worktreeDir, { recursive: true, force: true })
    }
  }
  rmSync(root, { recursive: true, force: true })
}

export default function globalTeardown(): void {
  if (!existsSync(TEST_REPO_PATH_FILE)) {
    return
  }

  const testRepoDir = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (testRepoDir && existsSync(testRepoDir)) {
    cleanupTestRepository(testRepoDir)
    console.error(`[e2e] Cleaned up test repo at ${testRepoDir}`)
  }

  rmSync(TEST_REPO_PATH_FILE, { force: true })
}
