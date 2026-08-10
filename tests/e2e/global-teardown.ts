/**
 * Playwright globalTeardown: cleans up the test git repo and worktrees.
 *
 * Why: the temp repo created by globalSetup should be removed after the
 * test run so we don't litter the user's /tmp with test directories.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { TEST_REPO_PATH_FILE } from './global-setup'

export default function globalTeardown(): void {
  if (!existsSync(TEST_REPO_PATH_FILE)) {
    return
  }

  const testRepoDir = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (testRepoDir && existsSync(testRepoDir)) {
    // Why: the shared temp directory can contain millions of unrelated entries.
    // Git already owns the exact worktree inventory, so never scan its siblings.
    try {
      const worktreeList = execFileSync(
        'git',
        ['-C', testRepoDir, 'worktree', 'list', '--porcelain'],
        { encoding: 'utf8' }
      )
      for (const line of worktreeList.split('\n')) {
        if (!line.startsWith('worktree ')) {
          continue
        }
        const worktreePath = line.slice('worktree '.length)
        const name = path.basename(worktreePath)
        if (
          path.dirname(worktreePath) === path.dirname(testRepoDir) &&
          (name.startsWith('orca-e2e-worktree-') || name.startsWith('e2e-test-'))
        ) {
          rmSync(worktreePath, { recursive: true, force: true })
        }
      }
    } catch {
      // Best-effort cleanup of worktrees
    }

    rmSync(testRepoDir, { recursive: true, force: true })
    console.error(`[e2e] Cleaned up test repo at ${testRepoDir}`)
  }

  rmSync(TEST_REPO_PATH_FILE, { force: true })
}
