import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'

export async function addAndActivateRepo(orcaPage: Page, repoPath: string): Promise<string> {
  const repoId = await orcaPage.evaluate(async (pathToRepo: string) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const addedRepo = await store.getState().addRepoPath(pathToRepo)
    if (!addedRepo) {
      throw new Error(`isolated repo not found: ${pathToRepo}`)
    }

    return addedRepo.id
  }, repoPath)

  // Why: fetchWorktrees() resolves before Zustand always reflects the async
  // worktree scan, so poll the same public store path real repo setup uses.
  await expect
    .poll(
      () =>
        orcaPage.evaluate(async (targetRepoId: string) => {
          const store = window.__store
          if (!store) {
            return 0
          }
          await store.getState().fetchWorktrees(targetRepoId)
          return store.getState().worktreesByRepo[targetRepoId]?.length ?? 0
        }, repoId),
      {
        timeout: 30_000,
        message: 'isolated large-diff worktree did not load'
      }
    )
    .toBeGreaterThan(0)

  const worktreeId = await orcaPage.evaluate(
    ({ targetRepoId, pathToRepo }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      const state = store.getState()
      const worktrees = state.worktreesByRepo[targetRepoId] ?? []
      const worktree = worktrees.find((entry) => entry.path === pathToRepo) ?? worktrees[0]
      if (!worktree) {
        throw new Error(`isolated worktree not found: ${pathToRepo}`)
      }
      state.setActiveRepo(targetRepoId)
      state.setActiveWorktree(worktree.id)
      return worktree.id
    },
    { targetRepoId: repoId, pathToRepo: repoPath }
  )

  return worktreeId
}
