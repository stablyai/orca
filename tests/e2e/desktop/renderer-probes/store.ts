import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import type { BrowserTabSummary, ExplorerFileSummary } from './runtime-types'

export async function getStoreState<T>(page: Page, selector: string): Promise<T> {
  return page.evaluate((selector) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available — is the app in dev mode?')
    }

    const state = store.getState()
    return selector.split('.').reduce<unknown>((value, key) => {
      if (value && typeof value === 'object') {
        return (value as Record<string, unknown>)[key]
      }

      return undefined
    }, state) as T
  }, selector)
}

export async function getActiveWorktreeId(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeWorktreeId')
}

export async function getActiveTabId(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeTabId')
}

export async function getActiveTabType(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeTabType')
}

export async function getWorktreeTabs(
  page: Page,
  worktreeId: string
): Promise<{ id: string; title?: string }[]> {
  return page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      return []
    }

    const state = store.getState()
    return (state.tabsByWorktree[worktreeId] ?? []).map((tab) => ({
      id: tab.id,
      title: tab.customTitle || tab.title
    }))
  }, worktreeId)
}

// Read the active split group’s tabOrder; use the legacy field only before split-group absorption.
export async function getTabBarOrder(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      return []
    }

    const state = store.getState()
    const groups = state.groupsByWorktree?.[worktreeId] ?? []
    const activeGroupId = state.activeGroupIdByWorktree?.[worktreeId]
    const activeGroup = activeGroupId
      ? groups.find((g: { id: string }) => g.id === activeGroupId)
      : groups[0]
    if (activeGroup?.tabOrder && activeGroup.tabOrder.length > 0) {
      const unifiedTabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
      return activeGroup.tabOrder.map((itemId: string) => {
        const tab = unifiedTabs.find((t: { id: string }) => t.id === itemId)
        if (!tab) {
          return itemId
        }
        return tab.contentType === 'terminal' || tab.contentType === 'browser'
          ? tab.entityId
          : tab.id
      })
    }
    return state.tabBarOrderByWorktree[worktreeId] ?? []
  }, worktreeId)
}

export async function getBrowserTabs(
  page: Page,
  worktreeId: string
): Promise<{ id: string; url?: string; title?: string }[]> {
  return page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      return []
    }

    const state = store.getState()
    return (state.browserTabsByWorktree[worktreeId] ?? []).map((tab): BrowserTabSummary => ({
      id: tab.id,
      url: tab.url,
      title: tab.title
    }))
  }, worktreeId)
}

export async function getOpenFiles(
  page: Page,
  worktreeId: string
): Promise<{ id: string; filePath: string; relativePath: string }[]> {
  return page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      return []
    }

    const state = store.getState()
    return state.openFiles
      .filter((file) => file.worktreeId === worktreeId)
      .map((file): ExplorerFileSummary => ({
        id: file.id,
        filePath: file.filePath,
        relativePath: file.relativePath
      }))
  }, worktreeId)
}

export async function waitForSessionReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(async () => getStoreState<boolean>(page, 'workspaceSessionReady'), {
      timeout: timeoutMs,
      message: 'workspaceSessionReady did not become true'
    })
    .toBe(true)
}

// Wait past hydration’s unawaited catalog refresh or it overwrites newly seeded fixtures.
export async function waitForStartupWorktreeRefresh(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect
    .poll(async () => getStoreState<boolean>(page, 'startupWorktreeRefreshCompleted'), {
      timeout: timeoutMs,
      message: 'startupWorktreeRefreshCompleted did not become true'
    })
    .toBe(true)
}

export async function waitForActiveWorktree(page: Page, timeoutMs = 30_000): Promise<string> {
  let activeWorktreeId: string | null = null
  await expect
    .poll(
      async () => {
        activeWorktreeId = await page.evaluate(() => {
          const store = window.__store
          if (!store) {
            return null
          }

          let state = store.getState()
          if (state.activeWorktreeId) {
            return state.activeWorktreeId
          }

          const firstWorktree = Object.values(state.worktreesByRepo).flat()[0]
          if (!firstWorktree) {
            return null
          }

          // Hydration may load rows without selection; retry store activation rather than hidden-window clicks.
          state.setActiveWorktree(firstWorktree.id)
          state = store.getState()
          return state.activeWorktreeId
        })
        return activeWorktreeId
      },
      {
        timeout: timeoutMs,
        message: 'activeWorktreeId did not become available'
      }
    )
    .not.toBeNull()

  return activeWorktreeId!
}

export async function getAllWorktreeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return []
    }

    const state = store.getState()
    const allWorktrees = Object.values(state.worktreesByRepo).flat()
    return allWorktrees.map((worktree) => worktree.id)
  })
}

export async function switchToOtherWorktree(
  page: Page,
  currentWorktreeId: string
): Promise<string | null> {
  return page.evaluate((currentId) => {
    const store = window.__store
    if (!store) {
      return null
    }

    const state = store.getState()
    const allWorktrees = Object.values(state.worktreesByRepo).flat()
    const other = allWorktrees.find((worktree) => worktree.id !== currentId)
    if (!other) {
      return null
    }

    state.setActiveWorktree(other.id)
    return other.id
  }, currentWorktreeId)
}

export async function switchToWorktree(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      return
    }

    store.getState().setActiveWorktree(id)
  }, worktreeId)
}

// Wait for the post-hydration terminal effect through store state because hidden-window visibility is unreliable.
export async function ensureTerminalVisible(page: Page, timeoutMs = 10_000): Promise<void> {
  // Give layout-owner publication a frame to create the first tab before creating a duplicate.
  const createAfter = Date.now() + Math.min(5_000, timeoutMs / 2)
  await expect
    .poll(
      async () =>
        page.evaluate((mayCreate) => {
          const store = window.__store
          if (!store) {
            return false
          }
          let state = store.getState()
          let worktreeId = state.activeWorktreeId
          if (!worktreeId) {
            const firstWorktree = Object.values(state.worktreesByRepo).flat()[0]
            if (!firstWorktree) {
              return false
            }
            // Reload can clear selection after readiness even though worktree rows are loaded.
            state.setActiveWorktree(firstWorktree.id)
            state = store.getState()
            worktreeId = state.activeWorktreeId ?? firstWorktree.id
          }

          const tabs = state.tabsByWorktree[worktreeId] ?? []
          const shownTab =
            tabs.find((tab) => tab.id === state.activeTabIdByWorktree[worktreeId]) ??
            tabs.find((tab) => tab.id === state.activeTabId) ??
            tabs[0]
          if (!shownTab && !mayCreate) {
            return false
          }
          // Use the production create action if the fresh profile’s auto-create effect has not finished.
          const activeTab = shownTab ?? state.createTab(worktreeId)
          state.setActiveTab(activeTab.id)
          if (state.activeTabType !== 'terminal') {
            state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
          }

          state = store.getState()
          if (state.activeTabType !== 'terminal' || state.activeWorktreeId !== worktreeId) {
            return false
          }
          return (state.tabsByWorktree[worktreeId] ?? []).some(
            (tab) => tab.id === state.activeTabId
          )
        }, Date.now() >= createAfter),
      { timeout: timeoutMs, message: 'No active terminal tab found for current worktree' }
    )
    .toBe(true)
}

export async function worktreeExists(page: Page, name: string): Promise<boolean> {
  return page.evaluate((name) => {
    const store = window.__store
    if (!store) {
      return false
    }

    const state = store.getState()
    const allWorktrees = Object.values(state.worktreesByRepo).flat()
    return allWorktrees.some(
      (worktree) => worktree.displayName === name || worktree.path.endsWith(`/${name}`)
    )
  }, name)
}
