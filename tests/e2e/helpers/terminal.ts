import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

// Why: worktree restoration can render the terminal surface before the legacy
// global activeTabId settles. Prefer the active worktree's saved terminal tab
// pointer, then fall back to the first terminal tab.
async function resolveActiveTabId(page: Page): Promise<string | null> {
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

// Why: reads the buffer through the SerializeAddon that the PaneManager
// already loads for every terminal pane (exposed via VITE_EXPOSE_STORE).
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

// Why: PTY IDs are opaque integers not exposed in the DOM. Probe each
// candidate with a unique marker and read back via SerializeAddon.
export async function discoverActivePtyId(page: Page): Promise<string> {
  const marker = `__PTY_PROBE_${Date.now()}__`

  const readCandidateIds = async (): Promise<string[]> => {
    const tabId = await resolveActiveTabId(page)
    if (!tabId) {
      return []
    }
    return page.evaluate((tabId) => {
      const store = window.__store
      if (!store) {
        return []
      }
      return store.getState().ptyIdsByTabId[tabId] ?? []
    }, tabId)
  }

  await expect
    .poll(readCandidateIds, {
      timeout: 15_000,
      message: 'discoverActivePtyId: active tab never received PTY candidates'
    })
    .not.toEqual([])

  const candidateIds = await readCandidateIds()

  if (candidateIds.length === 0) {
    // Why: blind-probing arbitrary PTY IDs can write into unrelated shells and
    // hides real regressions in the tab->PTY mapping the test depends on.
    throw new Error('discoverActivePtyId: active tab has no PTY candidates in store')
  }

  await page.evaluate(
    ({ marker, candidateIds }) => {
      for (const id of candidateIds) {
        window.api.pty.write(String(id), `\x03\x15echo ${marker}_${id}\r`)
      }
    },
    { marker, candidateIds }
  )

  let foundPtyId: string | null = null
  await expect
    .poll(
      async () => {
        const content = await getTerminalContent(page)
        const markerRe = new RegExp(`${marker}_(\\d+)`, 'g')
        const matches = [...content.matchAll(markerRe)]
        if (matches.length > 0) {
          foundPtyId = matches.at(-1)?.[1] ?? null
          return true
        }
        return false
      },
      { timeout: 10_000, message: 'PTY marker did not appear in terminal buffer' }
    )
    .toBe(true)

  if (!foundPtyId) {
    throw new Error('discoverActivePtyId: no marker found in terminal buffer')
  }

  return foundPtyId
}

export async function sendToTerminal(page: Page, ptyId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ ptyId, text }) => {
      window.api.pty.write(ptyId, text)
    },
    { ptyId, text }
  )
}

export async function execInTerminal(page: Page, ptyId: string, command: string): Promise<void> {
  await sendToTerminal(page, ptyId, `${command}\r`)
}

export async function waitForActiveTerminalManager(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const tabId = await resolveActiveTabId(page)
        if (!tabId) {
          return false
        }
        return page.evaluate((tabId) => {
          const paneManagers = window.__paneManagers
          if (!paneManagers) {
            return false
          }
          return (paneManagers.get(tabId)?.getPanes?.().length ?? 0) > 0
        }, tabId)
      },
      {
        timeout: timeoutMs,
        message: 'Active terminal PaneManager did not finish mounting'
      }
    )
    .toBe(true)
}

export async function splitActiveTerminalPane(
  page: Page,
  direction: 'vertical' | 'horizontal'
): Promise<void> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    throw new Error('splitActiveTerminalPane: no active terminal tab')
  }
  await page.evaluate(
    ({ tabId, direction }) => {
      const paneManagers = window.__paneManagers
      if (!paneManagers) {
        throw new Error('splitActiveTerminalPane: terminal store/manager unavailable')
      }

      const manager = paneManagers.get(tabId)
      const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      if (!manager?.splitPane || !activePane) {
        throw new Error('splitActiveTerminalPane: active pane manager not ready')
      }

      // Why: Electron key delivery to the terminal pane layer is flaky in E2E
      // even when the visible pane tree is mounted. Driving the active
      // PaneManager directly still exercises the real split/layout/PTY path
      // without depending on window-focus timing.
      manager.splitPane(activePane.id, direction)
    },
    { tabId, direction }
  )
}

export async function closeActiveTerminalPane(page: Page): Promise<void> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    throw new Error('closeActiveTerminalPane: no active terminal tab')
  }
  await page.evaluate((tabId) => {
    const paneManagers = window.__paneManagers
    if (!paneManagers) {
      throw new Error('closeActiveTerminalPane: terminal store/manager unavailable')
    }

    const manager = paneManagers.get(tabId)
    const panes = manager?.getPanes?.() ?? []
    if (!manager?.closePane || panes.length < 2) {
      return
    }

    const activePane = manager.getActivePane?.() ?? panes[0]
    if (!activePane) {
      return
    }

    manager.closePane(activePane.id)
  }, tabId)
}

export async function focusLastTerminalPane(page: Page): Promise<void> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    throw new Error('focusLastTerminalPane: no active terminal tab')
  }
  await page.evaluate((tabId) => {
    const paneManagers = window.__paneManagers
    if (!paneManagers) {
      throw new Error('focusLastTerminalPane: terminal store/manager unavailable')
    }

    const manager = paneManagers.get(tabId)
    const panes = manager?.getPanes?.() ?? []
    const lastPane = panes.at(-1) ?? null
    if (!manager?.setActivePane || !lastPane) {
      throw new Error('focusLastTerminalPane: active pane manager not ready')
    }

    manager.setActivePane(lastPane.id, { focus: true })
  }, tabId)
}

// Why: hidden-window E2E mode keeps DOM visibility signals false. The pane
// manager tracks the authoritative active split layout independently of CSS.
export async function countVisibleTerminalPanes(page: Page): Promise<number> {
  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    return 0
  }
  return page.evaluate((tabId) => {
    const managerCount = window.__paneManagers?.get(tabId)?.getPanes?.().length ?? 0
    if (managerCount > 0) {
      return managerCount
    }

    const layout = window.__store?.getState().terminalLayoutsByTabId[tabId]
    if (!layout) {
      return 0
    }

    // Why: `root: null` means the default single-pane tab (no splits yet).
    type N = { type: 'leaf' } | { type: 'split'; first: N | null; second: N | null } | null
    const countLeaves = (node: N): number => {
      if (!node || node.type === 'leaf') {
        return 1
      }
      return countLeaves(node.first) + countLeaves(node.second)
    }
    return countLeaves(layout.root as N)
  }, tabId)
}

export async function waitForTerminalOutput(
  page: Page,
  expected: string,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(async () => (await getTerminalContent(page)).includes(expected), {
      timeout: timeoutMs,
      message: `Terminal did not contain "${expected}"`
    })
    .toBe(true)
}

export async function waitForPaneCount(
  page: Page,
  expectedCount: number,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(async () => countVisibleTerminalPanes(page), {
      timeout: timeoutMs,
      message: `Expected ${expectedCount} visible terminal panes`
    })
    .toBe(expectedCount)
}
