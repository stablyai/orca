import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

// Why: the retention-budget spec needs several worktrees of ONE connected remote
// repo (adding a second repo mid-session misroutes its pty spawn to the local
// daemon — pre-existing multi-repo issue). Creation goes through the product's
// own createWorktree path so the result lands in worktreesByRepo (an external
// `git worktree add` only shows up as a detected worktree needing adoption).
// The create is polled: the relay channel can drop and reconnect shortly after
// connect, and an RPC inside that window fails with "Multiplexer disposed".
export async function createAndActivateDockerSshRelayWorktree(
  page: Page,
  repoId: string,
  worktreeName: string
): Promise<{ worktreeId: string }> {
  let worktreeId: string | null = null
  await expect
    .poll(
      async () => {
        worktreeId = await page.evaluate(
          async ({ repoId, worktreeName }) => {
            const store = window.__store
            if (!store) {
              throw new Error('Store unavailable')
            }
            // Why: a retried create must reuse a prior attempt's worktree
            // instead of failing forever on "already exists".
            const existing = (store.getState().worktreesByRepo[repoId] ?? []).find((candidate) =>
              candidate.path.endsWith(`/${worktreeName}`)
            )
            if (existing) {
              return existing.id
            }
            try {
              const result = await store.getState().createWorktree(repoId, worktreeName)
              await store.getState().fetchWorktrees(repoId)
              return result.worktree.id
            } catch {
              return null
            }
          },
          { repoId, worktreeName }
        )
        return worktreeId
      },
      {
        timeout: 90_000,
        message: `remote worktree ${worktreeName} was not created in repo ${repoId}`
      }
    )
    .not.toBeNull()
  if (!worktreeId) {
    throw new Error(`remote worktree ${worktreeName} did not resolve an id`)
  }
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setActiveWorktree(id)
    if ((store.getState().tabsByWorktree[id] ?? []).length === 0) {
      store.getState().createTab(id)
    }
    store.getState().setActiveTabType('terminal')
  }, worktreeId)
  return { worktreeId }
}
