import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { CommitMessageAiSettings } from '../../../src/shared/commit-message-ai-types'

// Raw git worktree add bypasses Orca’s 5s scan-cache invalidation; poll for 10s to cross the TTL and allow a slow scan.
const WORKTREE_CACHE_TTL_POLL_MS = 10_000

// Resolve a raw Git worktree through the renderer store after the scan-cache TTL.
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
            await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
            const repo = store.getState().repos.find((entry) => entry.path === repoPath)
            if (!repo) {
              throw new Error(`Seeded E2E repo was not registered: ${repoPath}`)
            }
            // Use the same store fetch as loadWorktreesUntilPathsPresent to keep TTL workarounds aligned.
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

// Resolve and activate the Source Control worktree, apply optional AI settings, then load status and open its sidebar.
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

// Poll past the scan-cache TTL until every raw-Git fixture worktree appears.
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
