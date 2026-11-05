import type { Page } from '@stablyai/playwright-test'

export type PaneIdentitySnapshot = {
  tabId: string
  activeLeafId: string | null
  storeActiveLeafId: string | null
  panes: {
    numericPaneId: number
    leafId: string
    stablePaneId: string
    datasetLeafId: string | null
    ptyId: string | null
  }[]
  ptyIdsByLeafId: Record<string, string>
}

export type ActivePaneHookDescriptor = {
  paneKey: string
  worktreeId: string
}

// Restoration may mount before global activeTabId settles; prefer the worktree’s saved tab, then its first terminal.
export async function resolveActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return null
    }
    const state = store.getState()
    const wId = state.activeWorktreeId
    if (!wId) {
      return null
    }
    const tabs = state.tabsByWorktree[wId] ?? []
    if (tabs.length === 0) {
      return null
    }
    const pref =
      state.activeTabType === 'terminal'
        ? state.activeTabId
        : (state.activeTabIdByWorktree?.[wId] ?? null)
    if (pref && tabs.some((t) => t.id === pref)) {
      return pref
    }
    return tabs[0]?.id ?? null
  })
}

export async function getTerminalContent(page: Page, charLimit = 4000): Promise<string> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    return ''
  }
  return page.evaluate(
    ({ tabId, charLimit }) => {
      const paneManagers = window.__paneManagers
      if (!paneManagers) {
        return ''
      }

      const manager = paneManagers.get(tabId)
      if (!manager) {
        return ''
      }

      const activePane = manager.getActivePane?.()
      if (!activePane) {
        const panes = manager.getPanes?.() ?? []
        if (panes.length === 0) {
          return ''
        }
        const text = panes[0].serializeAddon?.serialize?.() ?? ''
        return text.slice(-charLimit)
      }

      const text = activePane.serializeAddon?.serialize?.() ?? ''
      return text.slice(-charLimit)
    },
    { tabId, charLimit }
  )
}

export async function readPaneIdentitySnapshot(page: Page): Promise<PaneIdentitySnapshot | null> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    return null
  }

  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const store = window.__store
    if (!manager || !store) {
      return null
    }

    const activePane = manager.getActivePane?.() ?? null
    return {
      tabId,
      activeLeafId: activePane?.leafId ?? null,
      storeActiveLeafId: store.getState().terminalLayoutsByTabId[tabId]?.activeLeafId ?? null,
      panes: manager.getPanes().map((pane) => ({
        numericPaneId: pane.id,
        leafId: pane.leafId,
        stablePaneId: pane.stablePaneId,
        datasetLeafId: pane.container.dataset.leafId ?? null,
        ptyId: pane.container.dataset.ptyId ?? null
      })),
      ptyIdsByLeafId: store.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
    }
  }, tabId)
}
