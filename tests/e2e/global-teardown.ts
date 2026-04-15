/**
 * Playwright globalTeardown: cleans up the test git repo and worktrees.
 *
 * Why: the temp repo created by globalSetup should be removed after the
 * test run so we don't litter the user's /tmp with test directories.
 */

import { readFileSync, existsSync, rmSync, readdirSync } from 'fs'
import path from 'path'
import { TEST_REPO_PATH_FILE } from './global-setup'

export default function globalTeardown(): void {
  if (!existsSync(TEST_REPO_PATH_FILE)) {
    return
  }

  const testRepoDir = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (testRepoDir && existsSync(testRepoDir)) {
    // Why: git worktree add creates directories as siblings. Clean up any
    // orca-e2e-worktree-* directories in the same parent.
    const parentDir = path.dirname(testRepoDir)
    try {
      const siblings = readdirSync(parentDir)
      for (const name of siblings) {
        if (name.startsWith('orca-e2e-worktree-')) {
          rmSync(path.join(parentDir, name), { recursive: true, force: true })
        }
      }
    } catch {
      // Best-effort cleanup of worktrees
    }

    rmSync(testRepoDir, { recursive: true, force: true })
    console.log(`[e2e] Cleaned up test repo at ${testRepoDir}`)
  }

  rmSync(TEST_REPO_PATH_FILE, { force: true })
}
