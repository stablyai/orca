/** Validation for the git repo published by Playwright global setup. */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

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

export function requireSeededTestRepo(repoPath: string): string {
  if (!isValidGitRepo(repoPath)) {
    throw new Error(
      '[e2e] Playwright global setup did not publish a valid repo for this run; refusing to create an untracked worker fallback'
    )
  }
  return repoPath
}
