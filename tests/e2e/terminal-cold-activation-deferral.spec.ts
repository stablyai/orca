import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getActiveTabId, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

// Use eight tabs: seven hidden tabs exceed the four-cold-tab deferral threshold.
const TAB_COUNT = 8

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      throw new Error('createActiveTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
    return tab.id
  }, worktreeId)
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: 'newly created terminal tab did not become active'
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  return tabId
}

async function getTerminalTabSnapshots(
  page: Page,
  worktreeId: string
): Promise<{ id: string; ptyId: string | null }[]> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    return (state?.tabsByWorktree[id] ?? []).map((tab) => ({ id: tab.id, ptyId: tab.ptyId }))
  }, worktreeId)
}

async function getMountedTabIds(page: Page, tabIds: readonly string[]): Promise<string[]> {
  return page.evaluate(
    (ids) => ids.filter((tabId) => window.__paneManagers?.has(tabId) === true),
    tabIds
  )
}

async function enableTerminalAccessibilityDom(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    if (!pane) {
      throw new Error(`Terminal pane for ${id} is unavailable`)
    }
    // Enable screen-reader DOM rows for observable content from canvas-backed xterm.
    pane.terminal.options.screenReaderMode = true
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  }, tabId)
  await expect(
    page.locator(`[data-terminal-tab-id=${JSON.stringify(tabId)}] .xterm-accessibility-tree`)
  ).toBeAttached({ timeout: 10_000 })
}

test.describe('cold worktree activation deferral', () => {
  test('mounts only the visible tab cold and reveals deferred tabs on demand', async ({
    orcaPage: page
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await waitForActiveTerminalManager(page, 30_000)

    // Use child-worktree daemon ids; primary-worktree tabs are conservatively excluded from deferral.
    const worktreeId = await page.evaluate(async (name) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is unavailable')
      }
      const state = store.getState()
      const activeWorktreeId = state.activeWorktreeId
      const activeWorktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === activeWorktreeId)
      if (!activeWorktree) {
        throw new Error('active worktree not found')
      }
      const result = await state.createWorktree(activeWorktree.repoId, name)
      await state.fetchWorktrees(activeWorktree.repoId)
      state.setActiveWorktree(result.worktree.id)
      return result.worktree.id
    }, `e2e-cold-defer-${Date.now()}`)
    await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(worktreeId)

    while ((await getTerminalTabSnapshots(page, worktreeId)).length < TAB_COUNT) {
      await createActiveTerminalTab(page, worktreeId)
    }
    // Require daemon-backed PTYs so parked-byte watchers can own deferred side effects.
    await expect
      .poll(
        async () =>
          (await getTerminalTabSnapshots(page, worktreeId)).filter((tab) => tab.ptyId !== null)
            .length,
        { timeout: 30_000, message: 'tabs did not all get daemon PTY ids' }
      )
      .toBe(TAB_COUNT)
    const tabIds = (await getTerminalTabSnapshots(page, worktreeId)).map((tab) => tab.id)
    const lastActiveTabId = await getActiveTabId(page)

    // Run the production synchronous shutdown flush and inspect its persisted result.
    await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ id, expectedTabIds }) => {
              const session = await window.api.session.get()
              const persistedTabIds = new Set(
                (session.tabsByWorktree[id] ?? []).map((tab) => tab.id)
              )
              return expectedTabIds.every(
                (tabId) => persistedTabIds.has(tabId) && session.terminalLayoutsByTabId[tabId]
              )
            },
            { id: worktreeId, expectedTabIds: tabIds }
          ),
        { timeout: 10_000, message: 'terminal tabs and layouts were not persisted before reload' }
      )
      .toBe(true)

    // Reload against live daemon sessions so persisted tabs hydrate cold before activation chooses what to defer.
    await page.reload()
    await waitForSessionReady(page)
    await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(worktreeId)
    await expect
      .poll(async () => (await getTerminalTabSnapshots(page, worktreeId)).length, {
        timeout: 15_000,
        message: 'persisted terminal tabs did not survive the reload'
      })
      .toBe(TAB_COUNT)

    // The visible tab mounts immediately.
    await waitForActiveTerminalManager(page, 30_000)
    const mountedAfterActivation = await getMountedTabIds(page, tabIds)
    expect(mountedAfterActivation.length).toBeLessThanOrEqual(3)
    if (lastActiveTabId) {
      expect(mountedAfterActivation).toContain(lastActiveTabId)
    }

    // Require pane-less side effects so unmounted tabs cannot go silent and watcher commit is proven without sleep.
    let watcherCoveredTabIds: string[] = []
    await expect
      .poll(
        async () => {
          watcherCoveredTabIds = await page.evaluate(
            () =>
              (
                window as Window & { __terminalParkingDebug?: { parkedTabIds?: () => string[] } }
              ).__terminalParkingDebug?.parkedTabIds?.() ?? []
          )
          const mounted = await getMountedTabIds(page, tabIds)
          return tabIds.every(
            (tabId) => mounted.includes(tabId) || watcherCoveredTabIds.includes(tabId)
          )
        },
        { timeout: 10_000, message: 'deferred tabs did not receive watcher coverage' }
      )
      .toBe(true)
    const mountedAfterSettle = await getMountedTabIds(page, tabIds)
    expect(mountedAfterSettle).toEqual(mountedAfterActivation)
    for (const tabId of tabIds) {
      if (!mountedAfterSettle.includes(tabId)) {
        expect(watcherCoveredTabIds).toContain(tabId)
      }
    }

    // Revealing a deferred tab mounts it on demand.
    const deferredTabId = tabIds.find((tabId) => !mountedAfterSettle.includes(tabId))
    expect(deferredTabId).toBeDefined()
    if (!deferredTabId) {
      throw new Error('cold activation left no deferred tab to reveal')
    }
    await page.evaluate((tabId) => {
      const state = window.__store?.getState()
      state?.setActiveTab(tabId)
      state?.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
    }, deferredTabId)
    await expect
      .poll(async () => (await getMountedTabIds(page, [deferredTabId])).length, {
        timeout: 15_000,
        message: 'revealed deferred tab did not mount'
      })
      .toBe(1)

    await expect
      .poll(
        () =>
          page.evaluate((tabId) => {
            const parkedTabIds =
              (
                window as Window & { __terminalParkingDebug?: { parkedTabIds?: () => string[] } }
              ).__terminalParkingDebug?.parkedTabIds?.() ?? []
            return !parkedTabIds.includes(tabId)
          }, deferredTabId),
        { timeout: 10_000, message: 'revealed tab retained its parked watcher' }
      )
      .toBe(true)

    const revealedPtyId = await waitForActivePanePtyId(page, 15_000)
    await enableTerminalAccessibilityDom(page, deferredTabId)
    const outputMarker = `COLD_DEFER_REVEAL_OK_${Date.now()}`
    await execInTerminal(page, revealedPtyId, `echo ${outputMarker}`)
    await expect(
      page.locator(
        `[data-terminal-tab-id=${JSON.stringify(deferredTabId)}] .xterm-accessibility-tree`
      )
    ).toContainText(outputMarker, { timeout: 15_000 })
  })
})
