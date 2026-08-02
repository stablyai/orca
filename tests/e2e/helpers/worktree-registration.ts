import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { CommitMessageAiSettings } from '../../../src/shared/types'

// Why: these specs create worktrees via raw `git worktree add`, which bypasses
// Orca's own add/remove path — the one thing that invalidates the main-process
// worktrees.list scan cache (DETECTED_WORKTREE_SCAN_CACHE_TTL_MS = 5_000). So a
// read inside the TTL window can serve a stale miss. No renderer-reachable
// cache-invalidation seam exists without adding product surface, so poll past
// the deterministic 5s boundary. Budget 10s (not 6s, which sits dangerously
// close to a 5s TTL if one scan is slow); the informative message keeps a
// genuinely never-loading worktree failing loudly.
const WORKTREE_CACHE_TTL_POLL_MS = 10_000

/**
 * Loads the repo's worktrees into the renderer store and resolves the id of the
 * worktree at `targetWorktreePath`, polling past the 5s scan-cache TTL so a
 * raw `git worktree add` that Orca never observed still becomes visible.
 */
async function resolveE2eWorktreeId(
  page: Page,
  repoPath: string,
  targetWorktreePath: string
): Promise<string> {
  let worktreeId: string | null = null
  await expect
    .poll(
      async () => {
        worktreeId = await page.evaluate(
          async ({ repoPath, targetWorktreePath }) => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            await store.getState().fetchRepos()
            const repo = store.getState().repos.find((entry) => entry.path === repoPath)
            if (!repo) {
              throw new Error(`Seeded E2E repo was not registered: ${repoPath}`)
            }
            // Why: use the store's own fetch (like loadWorktreesUntilPathsPresent)
            // so both TTL workarounds stay behaviorally identical.
            await store.getState().fetchWorktrees(repo.id)
            const listedWorktrees = store.getState().worktreesByRepo[repo.id] ?? []
            const normalize = (value: string): string =>
              value.startsWith('/private/var/') ? value.slice('/private'.length) : value
            const worktree = listedWorktrees.find(
              (entry) => normalize(entry.path) === normalize(targetWorktreePath)
            )
            return worktree?.id ?? null
          },
          { repoPath, targetWorktreePath }
        )
        return worktreeId
      },
      {
        timeout: WORKTREE_CACHE_TTL_POLL_MS,
        message: `E2E worktree was not loaded within the worktree-cache TTL window: ${targetWorktreePath}`
      }
    )
    .not.toBeNull()

  if (!worktreeId) {
    throw new Error(`E2E worktree was not loaded: ${targetWorktreePath}`)
  }
  return worktreeId
}

/**
 * Shared setup for the Source Control specs: resolves the target worktree
 * (surviving the scan-cache TTL race), activates it, optionally applies AI
 * commit-message settings, loads its git status, and opens the Source Control
 * sidebar tab.
 */
export async function openSourceControlForWorktree(
  page: Page,
  repoPath: string,
  targetWorktreePath: string,
  options: { commitMessageAi?: CommitMessageAiSettings } = {}
): Promise<void> {
  const worktreeId = await resolveE2eWorktreeId(page, repoPath, targetWorktreePath)

  await page.evaluate(
    async ({ worktreeId, commitMessageAi }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const worktree = Object.values(store.getState().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)
      if (!worktree) {
        throw new Error(`E2E worktree disappeared from the store: ${worktreeId}`)
      }
      store.getState().setActiveWorktree(worktree.id)
      if (commitMessageAi) {
        await store.getState().updateSettings({ commitMessageAi })
      }
      const status = await window.api.git.status({ worktreePath: worktree.path })
      store.getState().setGitStatus(worktree.id, status)
      store.getState().setRightSidebarTab('source-control')
      store.getState().setRightSidebarOpen(true)
    },
    { worktreeId, commitMessageAi: options.commitMessageAi ?? null }
  )

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          return Boolean(state?.rightSidebarOpen && state?.rightSidebarTab === 'source-control')
        }),
      { timeout: 5_000 }
    )
    .toBe(true)
}

/**
 * Polls `fetchWorktrees` past the scan-cache TTL until every expected path is
 * registered in the store. Used by the Workspace Space git-status spec, which
 * adds 60 worktrees via raw git and would otherwise read a stale partial scan.
 */
export async function loadWorktreesUntilPathsPresent(
  page: Page,
  repoId: string,
  expectedPaths: string[]
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ repoId, expectedPaths }) => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            await store.getState().fetchWorktrees(repoId)
            const registered = new Set(
              (store.getState().worktreesByRepo[repoId] ?? []).map((entry) => entry.path)
            )
            return expectedPaths.every((entry) => registered.has(entry))
          },
          { repoId, expectedPaths }
        ),
      {
        timeout: WORKTREE_CACHE_TTL_POLL_MS,
        message: `Not all worktrees registered within the worktree-cache TTL window (${expectedPaths.length} expected)`
      }
    )
    .toBe(true)
}
