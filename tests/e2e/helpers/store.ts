/**
 * Zustand store inspection helpers for Orca E2E tests.
 *
 * Why: In dev mode, Orca exposes `window.__store` (the Zustand useAppStore).
 * Reading store state gives tests reliable access to app state without
 * fragile DOM scraping.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import type { BrowserTabSummary, ExplorerFileSummary, TerminalTabSummary } from './runtime-types'

/** Read a value from the Zustand store. Returns the raw JS value. */
export async function getStoreState<T>(page: Page, selector: string): Promise<T> {
  return page.evaluate((selector) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available — is the app in dev mode?')
    }

    const state = store.getState()
    // Support dot-notation selectors like 'activeWorktreeId' or 'tabsByWorktree'
    return selector.split('.').reduce<unknown>((value, key) => {
      if (value && typeof value === 'object') {
        return (value as Record<string, unknown>)[key]
      }

      return undefined
    }, state) as T
  }, selector)
}

/** Get the active worktree ID. */
export async function getActiveWorktreeId(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeWorktreeId')
}

/** Get the active tab ID. */
export async function getActiveTabId(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeTabId')
}

/** Get the active tab type ('terminal' | 'editor' | 'browser'). */
export async function getActiveTabType(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeTabType')
}

/** Get all terminal tabs for a given worktree. */
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
    return (state.tabsByWorktree[worktreeId] ?? []).map(
      (tab): TerminalTabSummary => ({
        id: tab.id,
        title: tab.customTitle || tab.title
      })
    )
  }, worktreeId)
}

/**
 * Get the tab bar order for a worktree.
 *
 * Why: split groups manage tab order via group.tabOrder on each TabGroup,
 * not the legacy tabBarOrderByWorktree field. Read from the active group's
 * tabOrder so drag-reorder assertions work with the split-group model.
 * Falls back to the legacy field for worktrees that haven't been absorbed
 * into the split-group model yet.
 */
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
    if (activeGroup?.tabOrder?.length > 0) {
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

/** Get browser tabs for a given worktree. */
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
    return (state.browserTabsByWorktree[worktreeId] ?? []).map(
      (tab): BrowserTabSummary => ({
        id: tab.id,
        url: tab.url,
        title: tab.title
      })
    )
  }, worktreeId)
}

/** Get open editor files for a given worktree. */
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
      .map(
        (file): ExplorerFileSummary => ({
          id: file.id,
          filePath: file.filePath,
          relativePath: file.relativePath
        })
      )
  }, worktreeId)
}

/** Wait until the workspace session is ready. Uses expect.poll for proper Playwright waiting. */
export async function waitForSessionReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(async () => getStoreState<boolean>(page, 'workspaceSessionReady'), {
      timeout: timeoutMs,
      message: 'workspaceSessionReady did not become true'
    })
    .toBe(true)
}

/** Wait until a worktree is active and return its ID. */
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

          // Why: isolated E2E sessions can hydrate worktree rows without
          // restoring a selection. Re-try store activation as worktrees load
          // instead of relying on sidebar option click hit targets.
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

/** Get all worktree IDs across all repos. */
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

/** Switch to a different worktree via the store. Returns the new worktree ID or null. */
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

/** Switch to a specific worktree via the store. */
export async function switchToWorktree(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      return
    }

    store.getState().setActiveWorktree(id)
  }, worktreeId)
}

/**
 * Ensure the active tab is a terminal and that the first terminal tab exists.
 *
 * Why: the first terminal tab is created by a renderer effect after session
 * hydration. Waiting on store state is more reliable than DOM visibility in
 * hidden-window mode and avoids racing that initial auto-create step.
 */
export async function ensureTerminalVisible(page: Page, timeoutMs = 10_000): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
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
            // Why: reload-based specs can briefly clear the active worktree
            // after session readiness while worktrees are already loaded.
            state.setActiveWorktree(firstWorktree.id)
            state = store.getState()
            worktreeId = state.activeWorktreeId ?? firstWorktree.id
          }

          const tabs = state.tabsByWorktree[worktreeId] ?? []
          const activeTab =
            tabs.find((tab) => tab.id === state.activeTabIdByWorktree[worktreeId]) ??
            tabs.find((tab) => tab.id === state.activeTabId) ??
            tabs[0] ??
            // Why: fresh isolated E2E profiles may not have finished the UI-driven
            // auto-create effect yet. Use the same store action to create the first
            // terminal tab so terminal-focused specs start from a stable baseline.
            state.createTab(worktreeId)
          state.setActiveTab(activeTab.id)
          if (state.activeTabType !== 'terminal') {
            state.setActiveTabType('terminal')
          }

          state = store.getState()
          if (state.activeTabType !== 'terminal' || state.activeWorktreeId !== worktreeId) {
            return false
          }
          return (state.tabsByWorktree[worktreeId] ?? []).some(
            (tab) => tab.id === state.activeTabId
          )
        }),
      { timeout: timeoutMs, message: 'No active terminal tab found for current worktree' }
    )
    .toBe(true)
}

/** Check if a worktree exists in the store. */
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
