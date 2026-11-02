import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { SIDEBAR_INPUTS_BUILD, expectNoSidebarShadowMismatches } from './helpers/sidebar-shadow'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { WorkspaceReviewFactsSnapshotSchema } from '../../src/shared/sidebar-list/workspace-review-facts'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'main publishes sidebar inputs only in an ORCA_SIDEBAR_INPUTS=main build'
)

/** Writes a PR into the window's cache the way a fetch result lands; returns the row's id. */
async function setWindowPRState(page: Page, state: 'open' | 'merged' | null): Promise<string> {
  return page.evaluate((state) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const current = store.getState()
    const worktree = Object.values(current.worktreesByRepo)
      .flat()
      .find((entry) => entry.branch.replace(/^refs\/heads\//, '') === 'e2e-secondary')
    if (!worktree) {
      throw new Error('seeded e2e-secondary worktree not found')
    }
    const key = `${worktree.repoId}::e2e-secondary`
    const pr = state && {
      number: 81,
      title: 'Review facts from E2E',
      state,
      url: 'https://github.com/acme/orca/pull/81',
      checksStatus: 'pending' as const,
      updatedAt: '2026-10-17T00:00:00.000Z',
      mergeable: 'UNKNOWN' as const
    }
    store.setState({ prCache: { ...current.prCache, [key]: { data: pr, fetchedAt: Date.now() } } })
    return worktree.id
  }, state)
}

async function readMainReviewFact(page: Page, worktreeId: string): Promise<unknown> {
  const response = await page.evaluate(() =>
    window.api.runtime.call({ method: 'sidebarInputs.reviewFacts' })
  )
  if (!response.ok) {
    throw new Error('sidebarInputs.reviewFacts failed')
  }
  return WorkspaceReviewFactsSnapshotSchema.parse(response.result).facts[worktreeId] ?? null
}

test('main follows the window PR cache for each workspace', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const worktreeId = await setWindowPRState(orcaPage, 'open')
  // The window mirrors its cache to main within a second of a change.
  await expect
    .poll(() => readMainReviewFact(orcaPage, worktreeId), { timeout: 5_000 })
    .toEqual({ provider: 'github', reviewState: 'open' })

  await setWindowPRState(orcaPage, 'merged')
  await expect
    .poll(() => readMainReviewFact(orcaPage, worktreeId), { timeout: 5_000 })
    .toEqual({ provider: 'github', reviewState: 'merged' })
  await expectNoSidebarShadowMismatches(orcaPage)

  await setWindowPRState(orcaPage, null)
  await expect.poll(() => readMainReviewFact(orcaPage, worktreeId), { timeout: 5_000 }).toBeNull()
  await expectNoSidebarShadowMismatches(orcaPage)
})
