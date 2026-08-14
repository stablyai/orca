import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

export function createGoldenWorktree(repoPath: string, label: string): GoldenWorktree {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const branchName = `e2e-golden-${label}-${suffix}`
  const worktreePath = path.join(os.tmpdir(), branchName)
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branchName], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  const fixture: GoldenWorktree = { branchName, worktreePath }
  // Callers only register cleanup once this returns, so roll back here or the
  // half-built worktree and branch leak into every later run.
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
    try {
      cleanupGoldenWorktree(repoPath, fixture)
    } catch {
      // Keep the setup failure as the reported cause.
    }
    throw setupError
  }
  return fixture
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
      () =>
        page.evaluate(
          async ({ registeredRepoPath, targetWorktreePath }) => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            await store.getState().fetchRepos()
            const normalize = (value: string): string => {
              const normalized = value
                .replace(/\\/g, '/')
                .replace(/^\/private(?=\/var\/)/, '')
                .replace(/\/+$/, '')
              return navigator.userAgent.includes('Windows') ? normalized.toLowerCase() : normalized
            }
            const repo = store
              .getState()
              .repos.find((entry) => normalize(entry.path) === normalize(registeredRepoPath))
            if (!repo) {
              return false
            }
            await store.getState().fetchWorktrees(repo.id)
            const worktree = (store.getState().worktreesByRepo[repo.id] ?? []).find(
              (entry) => normalize(entry.path) === normalize(targetWorktreePath)
            )
            if (!worktree) {
              return false
            }
            store.getState().setActiveRepo(repo.id)
            store.getState().setActiveWorktree(worktree.id)
            return true
          },
          { registeredRepoPath: repoPath, targetWorktreePath: worktreePath }
        ),
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
