/**
 * Playwright globalTeardown: cleans up the test git repo and worktrees.
 *
 * Why: the temp repo created by globalSetup should be removed after the
 * test run so we don't litter the user's /tmp with test directories.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { TEST_REPO_PATH_FILE } from './global-setup'

export function linkedWorktreePaths(testRepoDir: string): string[] {
  const root = realpathSync.native(testRepoDir)
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
    const canonicalPath = realpathSync.native(recordedPath)
    if (canonicalPath !== root) {
      linked.add(canonicalPath)
    }
  }
  return [...linked]
}

export function cleanupTestRepository(testRepoDir: string): void {
  const root = realpathSync.native(testRepoDir)
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

export function cleanupTestRepositoryPathFiles(runPathFile: string): void {
  const directory = dirname(runPathFile)
  if (!existsSync(directory)) {
    return
  }
  const workerPrefix = `${basename(runPathFile)}.worker-`
  const workerPathFiles = readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(workerPrefix) &&
        /^\d+$/.test(entry.name.slice(workerPrefix.length))
    )
    .map((entry) => join(directory, entry.name))
  for (const pathFile of [runPathFile, ...workerPathFiles]) {
    if (!existsSync(pathFile)) {
      continue
    }
    const testRepoDir = readFileSync(pathFile, 'utf-8').trim()
    if (testRepoDir && existsSync(testRepoDir)) {
      cleanupTestRepository(testRepoDir)
      console.error(`[e2e] Cleaned up test repo at ${testRepoDir}`)
    }
    rmSync(pathFile, { force: true })
  }
}

export default function globalTeardown(): void {
  cleanupTestRepositoryPathFiles(TEST_REPO_PATH_FILE)
}
