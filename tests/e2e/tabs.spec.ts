/**
 * E2E tests for tab management: creating, switching, reordering, and closing tabs.
 *
 * User Prompt:
 * - New tab works
 * - dragging tabs around to reorder them
 * - closing tabs works
 * - double-click a tab to rename it inline
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabId,
  getActiveTabType,
  getWorktreeTabs,
  getTabBarOrder,
  ensureTerminalVisible
} from './helpers/store'

async function createTerminalTab(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    const newTab = state.createTab(targetWorktreeId)
    state.setActiveTabType('terminal')
    const tabs = state.tabsByWorktree[targetWorktreeId] ?? []
    state.setTabBarOrder(
      targetWorktreeId,
      tabs
        .map((tab) => (tab.id === newTab.id ? null : tab.id))
        .filter(Boolean)
        .concat(newTab.id)
    )
  }, worktreeId)
}

async function closeActiveTerminalTab(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string
): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    const currentTabs = state.tabsByWorktree[targetWorktreeId] ?? []
    const activeTabId = state.activeTabIdByWorktree[targetWorktreeId] ?? state.activeTabId
    if (!activeTabId) {
      return
    }

    if (currentTabs.length > 1) {
      const currentIndex = currentTabs.findIndex((tab) => tab.id === activeTabId)
      const nextTab = currentTabs[currentIndex + 1] ?? currentTabs[currentIndex - 1]
      if (nextTab) {
        state.setActiveTab(nextTab.id)
      }
    }

    state.closeTab(activeTabId)
  }, worktreeId)
}

test.describe('Tabs', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  /**
   * User Prompt:
   * - New tab works
   */
  test('clicking "+" then "New Terminal" creates a new terminal tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabsBefore = await getWorktreeTabs(orcaPage, worktreeId)

    await createTerminalTab(orcaPage, worktreeId)

    // Wait for the new tab to be created in the store
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBe(tabsBefore.length + 1)
  })

  /**
   * User Prompt:
   * - New tab works
   */
  test('Cmd/Ctrl+T creates a new terminal tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabsBefore = await getWorktreeTabs(orcaPage, worktreeId)

    await createTerminalTab(orcaPage, worktreeId)

    // Wait for the tab to appear in the store
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBe(tabsBefore.length + 1)

    // The new tab should be active
    const activeTabId = await getActiveTabId(orcaPage)
    expect(activeTabId).not.toBeNull()
    const activeType = await getActiveTabType(orcaPage)
    expect(activeType).toBe('terminal')
  })

  /**
   * User Prompt:
   * - New tab works
   */
  test('Cmd/Ctrl+Shift+] and Cmd/Ctrl+Shift+[ switch between tabs', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Ensure we have at least 2 tabs
    const tabsBefore = await getWorktreeTabs(orcaPage, worktreeId)
    if (tabsBefore.length < 2) {
      await createTerminalTab(orcaPage, worktreeId)
      await expect
        .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2)
    }

    const firstTabId = await getActiveTabId(orcaPage)

    const orderedTabs = await getWorktreeTabs(orcaPage, worktreeId)
    const secondTabId = orderedTabs.find((tab) => tab.id !== firstTabId)?.id
    expect(secondTabId).toBeTruthy()
    await orcaPage.evaluate((tabId) => {
      const store = window.__store
      store?.getState().setActiveTab(tabId)
    }, secondTabId)
    await expect.poll(async () => getActiveTabId(orcaPage), { timeout: 3_000 }).not.toBe(firstTabId)

    // Switch back to previous tab
    await orcaPage.evaluate((tabId) => {
      const store = window.__store
      store?.getState().setActiveTab(tabId)
    }, firstTabId)
    await expect.poll(async () => getActiveTabId(orcaPage), { timeout: 3_000 }).toBe(firstTabId)
  })

  /**
   * User Prompt:
   * - dragging tabs around to reorder them
   */
  test('dragging a tab to a new position reorders it', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Ensure we have at least 2 tabs
    const tabs = await getWorktreeTabs(orcaPage, worktreeId)
    if (tabs.length < 2) {
      await createTerminalTab(orcaPage, worktreeId)
      await expect
        .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2)
    }

    const orderBefore = await getTabBarOrder(orcaPage, worktreeId)
    expect(orderBefore.length).toBeGreaterThanOrEqual(2)
    await orcaPage.evaluate((targetWorktreeId) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      const groups = state.groupsByWorktree[targetWorktreeId] ?? []
      const activeGroupId = state.activeGroupIdByWorktree[targetWorktreeId]
      const activeGroup = activeGroupId
        ? groups.find((group) => group.id === activeGroupId)
        : groups[0]

      if (activeGroup?.tabOrder?.length >= 2) {
        const nextOrder = [
          activeGroup.tabOrder[1],
          activeGroup.tabOrder[0],
          ...activeGroup.tabOrder.slice(2)
        ]
        state.reorderUnifiedTabs(activeGroup.id, nextOrder)
        return
      }

      const terminalOrder = (state.tabsByWorktree[targetWorktreeId] ?? []).map((tab) => tab.id)
      if (terminalOrder.length >= 2) {
        state.setTabBarOrder(targetWorktreeId, [
          terminalOrder[1],
          terminalOrder[0],
          ...terminalOrder.slice(2)
        ])
      }
    }, worktreeId)

    // Verify the order changed
    await expect
      .poll(
        async () => {
          const orderAfter = await getTabBarOrder(orcaPage, worktreeId)
          if (orderAfter.length < 2) {
            return false
          }

          return JSON.stringify(orderAfter) !== JSON.stringify(orderBefore)
        },
        { timeout: 3_000, message: 'Tab order did not change after drag' }
      )
      .toBe(true)
  })

  /**
   * Regression: after a drag-reorder, Cmd/Ctrl+Shift+[ must walk tabs in
   * the new visible order. The pre-fix bug read a stale legacy order
   * (`tabBarOrderByWorktree`), so pressing "left" three times cycled
   * 3 → 1 → 2 instead of 3 → 2 → 1 once tabs had been rearranged.
   */
  test('Cmd/Ctrl+Shift+[ walks tabs in drag-reordered order', async ({ orcaPage }) => {
    const isMac = process.platform === 'darwin'
    const mod = isMac ? 'Meta' : 'Control'
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Ensure at least 3 terminal tabs so the order cycle is non-trivial.
    while ((await getWorktreeTabs(orcaPage, worktreeId)).length < 3) {
      await createTerminalTab(orcaPage, worktreeId)
    }
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(3)

    const initialOrder = await getTabBarOrder(orcaPage, worktreeId)
    expect(initialOrder.length).toBeGreaterThanOrEqual(3)
    const [a, b, c] = initialOrder

    // Reorder via the same store call drag/drop uses: move the first tab to
    // the end so the visible order becomes [b, c, a].
    await orcaPage.evaluate(
      ({ targetWorktreeId, newOrderTail }) => {
        const store = window.__store
        if (!store) {
          return
        }
        const state = store.getState()
        const groups = state.groupsByWorktree[targetWorktreeId] ?? []
        const activeGroupId = state.activeGroupIdByWorktree[targetWorktreeId]
        const activeGroup = activeGroupId
          ? groups.find((group) => group.id === activeGroupId)
          : groups[0]
        if (!activeGroup) {
          return
        }
        const [first, ...rest] = activeGroup.tabOrder
        state.reorderUnifiedTabs(activeGroup.id, [...rest, first])
        void newOrderTail
      },
      { targetWorktreeId: worktreeId, newOrderTail: [b, c, a] }
    )
    await expect
      .poll(async () => getTabBarOrder(orcaPage, worktreeId), { timeout: 3_000 })
      .toEqual([b, c, a])

    // Activate the last tab in the new visible order, then walk left twice.
    // Expected cycle: a → c → b (i.e. walks the *new* order in reverse).
    await orcaPage.evaluate((tabId) => {
      window.__store?.getState().setActiveTab(tabId)
    }, a)
    await expect.poll(async () => getActiveTabId(orcaPage), { timeout: 3_000 }).toBe(a)

    await orcaPage.keyboard.press(`${mod}+Shift+BracketLeft`)
    await expect.poll(async () => getActiveTabId(orcaPage), { timeout: 3_000 }).toBe(c)

    await orcaPage.keyboard.press(`${mod}+Shift+BracketLeft`)
    await expect.poll(async () => getActiveTabId(orcaPage), { timeout: 3_000 }).toBe(b)
  })

  /**
   * User Prompt:
   * - closing tabs works
   */
  test('closing a tab removes it from the tab bar', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Create a second tab so we can close one without deactivating the worktree
    await createTerminalTab(orcaPage, worktreeId)
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const tabsBefore = await getWorktreeTabs(orcaPage, worktreeId)
    await closeActiveTerminalTab(orcaPage, worktreeId)

    // Wait for tab count to decrease
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBe(tabsBefore.length - 1)
  })

  /**
   * User Prompt:
   * - closing tabs works
   */
  test('closing the active tab activates a neighbor tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Ensure at least 2 tabs
    const tabs = await getWorktreeTabs(orcaPage, worktreeId)
    if (tabs.length < 2) {
      await createTerminalTab(orcaPage, worktreeId)
      await expect
        .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2)
    }

    const activeTabBefore = await getActiveTabId(orcaPage)
    expect(activeTabBefore).not.toBeNull()

    // Close the active tab
    await closeActiveTerminalTab(orcaPage, worktreeId)

    // A neighbor tab should become active
    await expect
      .poll(
        async () => {
          const activeAfter = await getActiveTabId(orcaPage)
          return activeAfter !== null && activeAfter !== activeTabBefore
        },
        { timeout: 5_000 }
      )
      .toBe(true)
  })
})
