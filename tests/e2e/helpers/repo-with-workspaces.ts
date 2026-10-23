import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import type { WorktreeMeta } from '../../../src/shared/worktree/meta-types'
import { expect } from './orca-app'
import { evaluatePolled } from './page-evaluate-polled'
import { loadWorktreesUntilPathsPresent } from './worktree-registration'

/** Poll budget for setup that makes one main write per item. */
export function bulkWriteTimeout(items: number): number {
  return 10_000 + items * 500
}

export type RepoWithWorkspaces = {
  repoId: string
  /** The repo's own checkout, listed as its main workspace. */
  mainId: string
  /** One workspace id per requested count, in order. */
  ids: string[]
}

/**
 * A fresh git repo with `count` worktrees, added through main as a user adds a project that already
 * has checkouts. Its worktrees are its own, so a spec never grows the worker's shared repo.
 */
export async function addRepoWithWorkspaces(
  page: Page,
  testInfo: TestInfo,
  count: number
): Promise<RepoWithWorkspaces> {
  const root = testInfo.outputPath('repo-with-workspaces')
  const repoPath = path.join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
  git('init', '-b', 'main')
  writeFileSync(path.join(repoPath, 'README.md'), 'workspaces\n')
  git('add', 'README.md')
  git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')
  const realRoot = realpathSync(root)
  const worktreePaths = Array.from({ length: count }, (_, index) => {
    const worktreePath = path.join(realRoot, `workspace-${index}`)
    git('worktree', 'add', '-q', '-b', `workspace-${index}`, worktreePath)
    return worktreePath
  })
  const realRepoPath = realpathSync(repoPath)
  const repoId = await evaluatePolled(
    page,
    async (repoPath) => {
      const added = await window.api.repos.add({ path: repoPath })
      if ('error' in added) {
        throw new Error(added.error)
      }
      return added.repo.id
    },
    realRepoPath
  )
  // The add's own refresh can supersede the helper's fetch, and updateRepo skips a repo the store lacks.
  await expect
    .poll(
      () =>
        page.evaluate(async (repoId) => {
          const store = window.__store!
          await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
          return store.getState().repos.some((repo) => repo.id === repoId)
        }, repoId),
      { message: 'the added repo never reached the store' }
    )
    .toBe(true)
  await evaluatePolled(
    page,
    async (repoId) => {
      // Checkouts made outside Orca's workspace root are hidden by default.
      const shown = await window
        .__store!.getState()
        .updateRepo(repoId, { externalWorktreeVisibility: 'show' })
      if (!shown) {
        throw new Error(`could not show external worktrees for ${repoId}`)
      }
    },
    repoId
  )
  await loadWorktreesUntilPathsPresent(page, repoId, [realRepoPath, ...worktreePaths])
  const idByPath = await page.evaluate(
    (repoId) =>
      Object.fromEntries(
        (window.__store!.getState().worktreesByRepo[repoId] ?? []).map((worktree) => [
          worktree.path,
          worktree.id
        ])
      ),
    repoId
  )
  return {
    repoId,
    mainId: idByPath[realRepoPath]!,
    ids: worktreePaths.map((worktreePath) => idByPath[worktreePath]!)
  }
}

/** Writes workspace metadata through main, all at once, and fails unless main lists it. */
export async function writeWorkspaceMeta(
  page: Page,
  updates: { worktreeId: string; updates: Partial<WorktreeMeta> }[]
): Promise<void> {
  await evaluatePolled(
    page,
    async (updates) => {
      // The store keeps its own copy when main refuses, so check main's listing.
      await window.__store!.getState().updateWorktreesMeta(updates)
      const repoIds = [...new Set(updates.map(({ worktreeId }) => worktreeId.split('::')[0]!))]
      const listed = new Map(
        (await Promise.all(repoIds.map((repoId) => window.api.worktrees.list({ repoId }))))
          .flat()
          .map((worktree) => [worktree.id, worktree])
      )
      for (const { worktreeId, updates: written } of updates) {
        const worktree = listed.get(worktreeId)
        if (!worktree) {
          throw new Error(`main does not list ${worktreeId}`)
        }
        const kept = new Map(Object.entries(worktree))
        for (const [field, value] of Object.entries(written)) {
          if (JSON.stringify(kept.get(field)) !== JSON.stringify(value)) {
            throw new Error(`main did not keep ${field} for ${worktreeId}`)
          }
        }
      }
    },
    updates,
    { timeout: bulkWriteTimeout(updates.length) }
  )
}

/** Links each child under its parent through main, as "Set parent workspace" does. */
export async function linkWorkspaces(
  page: Page,
  links: { childId: string; parentId: string }[]
): Promise<void> {
  await evaluatePolled(
    page,
    async (links) => {
      for (const { childId, parentId } of links) {
        await window
          .__store!.getState()
          .assignWorktreeParent(childId, { parentWorktreeId: parentId })
      }
    },
    links,
    { timeout: bulkWriteTimeout(links.length) }
  )
}
