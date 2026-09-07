import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

export const GOLDEN_CHANGED_PATH = 'src/index.ts'
export const GOLDEN_REMOVED_LINE = 'export const hello = "world"'
export const GOLDEN_ADDED_LINE = 'export const hello = "golden daily loop"'
export const GOLDEN_GIT_AUTHOR_NAME = 'Orca E2E'
export const GOLDEN_GIT_AUTHOR_EMAIL = 'orca-e2e@example.invalid'
const GOLDEN_PRE_COMMIT_MARKER = '.e2e-pre-commit-ran'

export type GoldenWorktree = {
  branchName: string
  hooksPath?: string
  worktreePath: string
}

function existingNativeRealpath(value: string): string {
  try {
    return realpathSync.native(value)
  } catch {
    return value
  }
}

/** Slash-fold, strip macOS /private, and expand 8.3 aliases so Git listings match. */
export function canonicalizeGoldenWorktreePath(
  value: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalized = existingNativeRealpath(value)
    .replace(/\\/g, '/')
    .replace(/^\/private(?=\/var\/)/, '')
    .replace(/\/+$/, '')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function goldenWorktreePathsMatch(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (
    canonicalizeGoldenWorktreePath(left, platform) ===
    canonicalizeGoldenWorktreePath(right, platform)
  )
}

export function createGoldenWorktree(repoPath: string, label: string): GoldenWorktree {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const branchName = `e2e-golden-${label}-${suffix}`
  const requestedPath = path.join(os.tmpdir(), branchName)
  execFileSync('git', ['worktree', 'add', requestedPath, '-b', branchName], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  // Callers only register cleanup once this returns, so roll back here or the
  // half-built worktree and branch leak into every later run.
  // Why: Windows CI tmpdir is often the 8.3 alias (RUNNER~1) while Git lists
  // the long path (runneradmin). Seeded repos already realpath; this extra
  // worktree must too or activateGoldenWorktree never matches the sidebar.
  let worktreePath: string
  try {
    worktreePath = realpathSync.native(requestedPath)
  } catch (realpathError) {
    rollbackGoldenWorktree(repoPath, { branchName, worktreePath: requestedPath })
    throw realpathError
  }
  const fixture: GoldenWorktree = { branchName, worktreePath }
  try {
    execFileSync('git', ['config', 'extensions.worktreeConfig', 'true'], {
      cwd: worktreePath,
      stdio: 'pipe'
    })
    execFileSync('git', ['config', '--worktree', 'user.name', GOLDEN_GIT_AUTHOR_NAME], {
      cwd: worktreePath,
      stdio: 'pipe'
    })
    execFileSync('git', ['config', '--worktree', 'user.email', GOLDEN_GIT_AUTHOR_EMAIL], {
      cwd: worktreePath,
      stdio: 'pipe'
    })
  } catch (setupError) {
    rollbackGoldenWorktree(repoPath, fixture)
    throw setupError
  }
  return fixture
}

/** Best-effort cleanup that keeps the original setup failure as the reported cause. */
function rollbackGoldenWorktree(repoPath: string, fixture: GoldenWorktree): void {
  try {
    cleanupGoldenWorktree(repoPath, fixture)
  } catch {
    // Intentionally ignored.
  }
}

export function cleanupGoldenWorktree(repoPath: string, fixture: GoldenWorktree): void {
  try {
    execFileSync('git', ['config', '--worktree', '--unset-all', 'core.hooksPath'], {
      cwd: fixture.worktreePath,
      stdio: 'pipe'
    })
  } catch {
    // The hook setting may not have been installed before setup failed.
  }
  if (fixture.hooksPath) {
    rmSync(fixture.hooksPath, { recursive: true, force: true })
  }
  try {
    execFileSync('git', ['worktree', 'remove', '--force', fixture.worktreePath], {
      cwd: repoPath,
      stdio: 'pipe'
    })
  } catch {
    rmSync(fixture.worktreePath, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'pipe' })
  }
  execFileSync('git', ['branch', '-D', fixture.branchName], { cwd: repoPath, stdio: 'pipe' })
}

export function seedGoldenSourceEdit(worktreePath: string): void {
  const changedPath = path.join(worktreePath, GOLDEN_CHANGED_PATH)
  const original = readFileSync(changedPath, 'utf8')
  if (!original.includes(GOLDEN_REMOVED_LINE)) {
    throw new Error(`Golden source fixture is missing: ${GOLDEN_REMOVED_LINE}`)
  }
  writeFileSync(changedPath, original.replace(GOLDEN_REMOVED_LINE, GOLDEN_ADDED_LINE))
}

export function installPassingNodePreCommitHook(fixture: GoldenWorktree): string {
  const hooksPath = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-git-hooks-'))
  const hookPath = path.join(hooksPath, 'pre-commit')
  const markerPath = path.join(hooksPath, GOLDEN_PRE_COMMIT_MARKER)
  fixture.hooksPath = hooksPath
  execFileSync('git', ['config', '--worktree', 'core.hooksPath', hooksPath], {
    cwd: fixture.worktreePath,
    stdio: 'pipe'
  })
  writeFileSync(
    hookPath,
    `#!/bin/sh\nnode -e "const fs = require('node:fs'); const path = require('node:path'); fs.writeFileSync(path.join(path.dirname(process.argv[1]), '${GOLDEN_PRE_COMMIT_MARKER}'), 'ran')" "$0"\n`
  )
  chmodSync(hookPath, 0o755)
  return markerPath
}

export async function activateGoldenWorktree(
  page: Page,
  repoPath: string,
  worktreePath: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const listed = await page.evaluate(async () => {
          const store = window.__store
          if (!store) {
            throw new Error('window.__store is not available')
          }
          await store.getState().fetchRepos()
          const repos: {
            id: string
            path: string
            worktrees: { id: string; path: string }[]
          }[] = []
          for (const repo of store.getState().repos) {
            await store.getState().fetchWorktrees(repo.id)
            repos.push({
              id: repo.id,
              path: repo.path,
              worktrees: (store.getState().worktreesByRepo[repo.id] ?? []).map((entry) => ({
                id: entry.id,
                path: entry.path
              }))
            })
          }
          return repos
        })
        // Why: compare on the Node side so realpath can expand Windows 8.3
        // aliases. page.evaluate cannot call realpathSync.
        const repo = listed.find((entry) => goldenWorktreePathsMatch(entry.path, repoPath))
        const worktree = repo?.worktrees.find((entry) =>
          goldenWorktreePathsMatch(entry.path, worktreePath)
        )
        if (!repo || !worktree) {
          return false
        }
        await page.evaluate(
          ({ repoId, worktreeId }) => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            store.getState().setActiveRepo(repoId)
            store.getState().setActiveWorktree(worktreeId)
          },
          { repoId: repo.id, worktreeId: worktree.id }
        )
        return true
      },
      { timeout: 10_000, message: `Golden worktree did not load: ${worktreePath}` }
    )
    .toBe(true)
}

export async function openGoldenSourceControl(
  page: Page,
  repoPath: string,
  fixture: GoldenWorktree
): Promise<void> {
  await activateGoldenWorktree(page, repoPath, fixture.worktreePath)
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    state.setRightSidebarTab('explorer')
    state.setRightSidebarOpen(true)
  })
  await page.getByRole('button', { name: /Source Control/ }).click()
  await expect(page.getByRole('textbox', { name: 'Commit message' })).toBeVisible({
    timeout: 10_000
  })
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          return state?.activeWorktreeId
            ? Object.hasOwn(state.gitStatusByWorktree, state.activeWorktreeId)
            : false
        }),
      { timeout: 10_000, message: 'Automatic Git status refresh did not complete' }
    )
    .toBe(true)
}
