// #532: removal must drop owned terminal/editor/browser state.
// #598/#628/#726: preserve per-worktree/sidebar state across switching; this model arm cannot prove a responsive render loop.
// #542/#554: reject terminal tab ids shared across worktrees.

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getAllWorktreeIds,
  getWorktreeTabs,
  getOpenFiles,
  getBrowserTabs,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'

async function createIsolatedWorktree(
  page: Parameters<typeof getActiveWorktreeId>[0]
): Promise<string> {
  const name = `e2e-lifecycle-${Date.now()}`
  return page.evaluate(async (worktreeName) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    const activeWorktreeId = state.activeWorktreeId
    if (!activeWorktreeId) {
      throw new Error('No active worktree to derive repo from')
    }

    const activeWorktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === activeWorktreeId)
    if (!activeWorktree) {
      throw new Error(`Active worktree ${activeWorktreeId} not found`)
    }

    const result = await state.createWorktree(activeWorktree.repoId, worktreeName)
    await state.fetchWorktrees(activeWorktree.repoId)
    return result.worktree.id
  }, name)
}

async function removeWorktreeViaStore(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<{ ok: boolean; error?: string }> {
  return page.evaluate(async (id) => {
    const store = window.__store
    if (!store) {
      return { ok: false as const, error: 'store unavailable' }
    }

    const state = store.getState()
    const result = await state.removeWorktree(
      { id, executionHostId: state.getKnownWorktreeById(id)?.hostId ?? null },
      true
    )
    return result
  }, worktreeId)
}

test.describe('Worktree Lifecycle', () => {
  // Track isolated worktrees for afterEach cleanup so aborted tests cannot leak branches/directories into the shared worker.
  let createdWorktreeId: string | null = null

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    if (!createdWorktreeId) {
      return
    }
    const idToClean = createdWorktreeId
    createdWorktreeId = null
    await orcaPage
      .evaluate(async (id) => {
        try {
          const state = window.__store?.getState()
          await state?.removeWorktree(
            { id, executionHostId: state.getKnownWorktreeById(id)?.hostId ?? null },
            true
          )
        } catch {
          /* best-effort cleanup */
        }
      }, idToClean)
      .catch(() => undefined)
  })

  // #532: removing a worktree must drop all owned surface state.
  test('removing a worktree clears its tabs, open files, and browser tabs', async ({
    orcaPage
  }) => {
    const originalWorktreeId = await waitForActiveWorktree(orcaPage)

    createdWorktreeId = await createIsolatedWorktree(orcaPage)
    const newWorktreeId = createdWorktreeId
    await switchToWorktree(orcaPage, newWorktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
      .toBe(newWorktreeId)
    await ensureTerminalVisible(orcaPage)

    // Seed all three surface types to require atomic cleanup.
    await orcaPage.evaluate((worktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      state.createTab(worktreeId)
      state.createBrowserTab(worktreeId, 'about:blank', {
        title: 'lifecycle-test',
        activate: false
      })
    }, newWorktreeId)

    await openFileExplorer(orcaPage)
    await clickFileInExplorer(orcaPage, ['README.md', 'package.json'])

    expect((await getWorktreeTabs(orcaPage, newWorktreeId)).length).toBeGreaterThan(0)
    expect((await getBrowserTabs(orcaPage, newWorktreeId)).length).toBeGreaterThan(0)
    expect((await getOpenFiles(orcaPage, newWorktreeId)).length).toBeGreaterThan(0)

    // Remove an inactive worktree; deleting the active one follows an easier path that misses this cleanup regression.
    await switchToWorktree(orcaPage, originalWorktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
      .toBe(originalWorktreeId)

    const result = await removeWorktreeViaStore(orcaPage, newWorktreeId)
    expect(result.ok).toBe(true)
    createdWorktreeId = null

    // Require all removed-worktree keyed surfaces gone to prevent a worktree-less tab strip.
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, newWorktreeId)).length, {
        timeout: 10_000,
        message: 'tabsByWorktree still holds entries for the removed worktree'
      })
      .toBe(0)
    await expect
      .poll(async () => (await getBrowserTabs(orcaPage, newWorktreeId)).length, { timeout: 5_000 })
      .toBe(0)
    await expect
      .poll(async () => (await getOpenFiles(orcaPage, newWorktreeId)).length, { timeout: 5_000 })
      .toBe(0)

    const allIds = await getAllWorktreeIds(orcaPage)
    expect(allIds).not.toContain(newWorktreeId)
  })

  // Assert layout/openFiles/sidebar state preservation, a narrower claim than renderer responsiveness.
  // A hanging page.evaluate cannot distinguish a frozen React loop; #726’s mounted-layout invariant has separate unit coverage.
  test('switching worktrees preserves per-worktree state across a round-trip', async ({
    orcaPage
  }) => {
    const allIds = await getAllWorktreeIds(orcaPage)
    expect(
      allIds.length,
      'fixture should provide primary + e2e-secondary worktrees'
    ).toBeGreaterThanOrEqual(2)

    const originalWorktreeId = await waitForActiveWorktree(orcaPage)

    await openFileExplorer(orcaPage)
    await clickFileInExplorer(orcaPage, ['README.md', 'package.json'])

    // Require nonempty openFiles before capturing state so preservation cannot be tautological.
    const originalState = await orcaPage.evaluate((wId) => {
      const store = window.__store
      if (!store) {
        // Fail a missing store explicitly rather than null-dereference.
        return { openFileIds: [] as string[], hasLayout: false }
      }
      const state = store.getState()
      return {
        openFileIds: state.openFiles.filter((f) => f.worktreeId === wId).map((f) => f.id),
        hasLayout: Boolean(state.layoutByWorktree?.[wId])
      }
    }, originalWorktreeId)
    expect(
      originalState.openFileIds.length,
      'expected seeded openFiles on original worktree'
    ).toBeGreaterThan(0)

    const otherWorktreeId = allIds.find((id) => id !== originalWorktreeId)!
    await switchToWorktree(orcaPage, otherWorktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
      .toBe(otherWorktreeId)

    // Require sidebar UI state after the switch.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            const state = window.__store?.getState()
            return Boolean(state?.rightSidebarOpen && state?.rightSidebarTab === 'explorer')
          }),
        { timeout: 5_000, message: 'Right sidebar state was lost during worktree switch' }
      )
      .toBe(true)

    await switchToWorktree(orcaPage, originalWorktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
      .toBe(originalWorktreeId)

    // Require original openFiles/layout after return, beyond activeWorktreeId round-trip.
    const afterRoundTrip = await orcaPage.evaluate((wId) => {
      const store = window.__store
      if (!store) {
        // Match the initial store guard for useful failure diagnostics.
        return { openFileIds: [] as string[], hasLayout: false }
      }
      const state = store.getState()
      return {
        openFileIds: state.openFiles.filter((f) => f.worktreeId === wId).map((f) => f.id),
        hasLayout: Boolean(state.layoutByWorktree?.[wId])
      }
    }, originalWorktreeId)
    expect(new Set(afterRoundTrip.openFileIds)).toEqual(new Set(originalState.openFileIds))
    expect(afterRoundTrip.hasLayout).toBe(originalState.hasLayout)
  })

  // #542/#554: terminal membership must not share ids between worktrees, the model invariant behind wrong-worktree shortcuts.
  test('terminal tabs stay scoped to the worktree that created them', async ({ orcaPage }) => {
    const allIds = await getAllWorktreeIds(orcaPage)
    expect(
      allIds.length,
      'fixture should provide primary + e2e-secondary worktrees'
    ).toBeGreaterThanOrEqual(2)

    const worktreeA = await waitForActiveWorktree(orcaPage)
    const worktreeB = allIds.find((id) => id !== worktreeA)!

    await orcaPage.evaluate((worktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }

      store.getState().createTab(worktreeId)
    }, worktreeA)
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeA)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    await switchToWorktree(orcaPage, worktreeB)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
      .toBe(worktreeB)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate((worktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }

      store.getState().createTab(worktreeId)
    }, worktreeB)
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeB)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const tabsA = await getWorktreeTabs(orcaPage, worktreeA)
    const tabsB = await getWorktreeTabs(orcaPage, worktreeB)
    const idsA = new Set(tabsA.map((tab) => tab.id))
    const idsB = new Set(tabsB.map((tab) => tab.id))

    const overlap = [...idsA].filter((id) => idsB.has(id))
    expect(overlap, 'tabsByWorktree leaked tab IDs across worktrees').toEqual([])
  })
})
