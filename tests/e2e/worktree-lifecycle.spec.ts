// #532: removal must drop owned terminal/editor/browser state.

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
})
