/**
 * E2E tests for the full worktree lifecycle: removal cleanup, switching with
 * the right sidebar open, and cross-worktree tab isolation.
 *
 * Why these flows:
 * - PR #532 (`clean up editor/terminal state when removing a worktree`) showed
 *   that removeWorktree must drop the tabs/editors/browser tabs owned by the
 *   removed worktree. A regression here silently leaks a deleted worktree's
 *   IDs into tabsByWorktree / openFiles and breaks the UI the next time the
 *   user opens another worktree.
 * - PR #628 (`resolve Windows freeze when switching worktrees with right
 *   sidebar open`) + PR #598 (`resolve right sidebar freeze on Windows`) +
 *   PR #726 (`prevent split-group container teardown when switching
 *   worktrees`) all changed behavior on the same path: activating a different
 *   worktree while the right sidebar is showing. Assert that the switch lands
 *   cleanly with the sidebar still open, because the prior regressions left
 *   the UI hung.
 * - PR #542 / #554 (`terminal shortcuts firing in wrong worktree`) regressed
 *   twice. Cover the invariant directly: a terminal tab created in worktree A
 *   must not appear in worktree B's tab list.
 */

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

    const result = await store.getState().removeWorktree(id, true)
    return result
  }, worktreeId)
}

test.describe('Worktree Lifecycle', () => {
  // Why: `createIsolatedWorktree` materializes a real on-disk worktree in the
  // worker-scoped seed repo. If a mid-test assertion fails, that branch +
  // working directory leaks across subsequent tests in the same worker. Track
  // the ID here and best-effort remove it in afterEach so fixture state stays
  // clean even when a test aborts before its own cleanup runs.
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
          await window.__store?.getState().removeWorktree(id, true)
        } catch {
          /* best-effort cleanup */
        }
      }, idToClean)
      .catch(() => undefined)
  })

  /**
   * Covers PR #532: removing a worktree must drop its tab/editor/browser state
   * from the store, not leak IDs into the next render.
   */
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

    // Seed one of each surface on the new worktree so removeWorktree has to
    // clean up all three in a single atomic set().
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

    // Baseline: the new worktree now has tabs/browser tabs/open files.
    expect((await getWorktreeTabs(orcaPage, newWorktreeId)).length).toBeGreaterThan(0)
    expect((await getBrowserTabs(orcaPage, newWorktreeId)).length).toBeGreaterThan(0)
    expect((await getOpenFiles(orcaPage, newWorktreeId)).length).toBeGreaterThan(0)

    // Switch away before removing so we're not deleting the active worktree —
    // that's an easier code path and hides the cleanup regression this spec
    // is protecting.
    await switchToWorktree(orcaPage, originalWorktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 10_000 })
      .toBe(originalWorktreeId)

    const result = await removeWorktreeViaStore(orcaPage, newWorktreeId)
    expect(result.ok).toBe(true)
    // Successful removal — afterEach hook no longer needs to clean this up.
    createdWorktreeId = null

    // Tabs / open files / browser tabs keyed by the removed worktree must all
    // be dropped. A regression that leaves any of these behind will show up
    // in the sidebar as a worktree-less tab strip.
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

  /**
   * Worktree switching preserves per-worktree state — specifically
   * `layoutByWorktree`, `openFiles`, and the right-sidebar UI state across a
   * round-trip.
   *
   * Why a narrowed claim: the original #598 / #628 regressions were renderer
   * freezes, and #726 was split-group container teardown. Those are
   * *renderer-side* bugs — a store-level test can't observe a frozen React
   * render loop (if the renderer hung, `page.evaluate` would hang too, which
   * looks identical to any other timeout). #726 in particular is already
   * guarded at the unit level by `anyMountedWorktreeHasLayout` tests per its
   * PR summary.
   *
   * What this test *does* catch: regressions that wipe per-worktree store
   * state during a switch — e.g. a cascading reducer that clears
   * `layoutByWorktree[oldWorktreeId]` when activating a new worktree, or a
   * sidebar-reset side effect attached to `setActiveWorktree`. That's a
   * smaller claim than "doesn't hang," but it's one this layer can actually
   * verify.
   */
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

    // Snapshot the original worktree's state so we can assert preservation
    // after the round-trip. An empty `openFiles` here would make the second
    // assertion tautological, so guard that expectation up-front.
    const originalState = await orcaPage.evaluate((wId) => {
      const store = window.__store
      if (!store) {
        // Surface a store-unavailable failure via a clear empty baseline
        // rather than a null-deref inside page.evaluate.
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

    // Sidebar UI state must survive the switch — user shouldn't have to
    // re-open the explorer after every worktree change.
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

    // Original worktree's state must be intact: the openFiles it had before
    // the switch are all still present, and its layout entry (if any) was
    // not torn down. A regression that clears these on setActiveWorktree
    // would fail here even though `activeWorktreeId` round-tripped cleanly.
    const afterRoundTrip = await orcaPage.evaluate((wId) => {
      const store = window.__store
      if (!store) {
        // Match the originalState guard so assertion failures point at
        // "store gone" instead of a null-deref stack.
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

  /**
   * Covers PR #542 / #554: a regression caused terminal tab membership to
   * leak across worktrees (the wrong worktree's tab reacted to shortcuts).
   * Guard the underlying invariant — tabsByWorktree[A] and tabsByWorktree[B]
   * do not share IDs — at the model layer where the bug actually lived.
   */
  test('terminal tabs stay scoped to the worktree that created them', async ({ orcaPage }) => {
    const allIds = await getAllWorktreeIds(orcaPage)
    expect(
      allIds.length,
      'fixture should provide primary + e2e-secondary worktrees'
    ).toBeGreaterThanOrEqual(2)

    const worktreeA = await waitForActiveWorktree(orcaPage)
    const worktreeB = allIds.find((id) => id !== worktreeA)!

    // Create an extra tab on A so it has a distinctive tab ID set.
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

    // Switch to B and create a tab there too.
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
