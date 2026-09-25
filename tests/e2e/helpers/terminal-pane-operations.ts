import { expect, type Page } from '@stablyai/playwright-test'
import {
  getTerminalContent,
  readPaneIdentitySnapshot,
  resolveActiveTabId
} from './terminal-pane-identity'

export async function readTerminalPaneDomLeafOrder(page: Page): Promise<string[]> {
  const snapshot = await readPaneIdentitySnapshot(page)
  if (!snapshot) {
    return []
  }

  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    if (!manager) {
      return []
    }
    const paneElements = new Set(manager.getPanes().map((pane) => pane.container))
    return Array.from(document.querySelectorAll<HTMLElement>('.pane[data-leaf-id]'))
      .filter((element) => paneElements.has(element))
      .map((element) => element.dataset.leafId ?? '')
      .filter((leafId) => leafId.length > 0)
  }, snapshot.tabId)
}

export async function moveTerminalPaneByLeafId(
  page: Page,
  sourceLeafId: string,
  targetLeafId: string,
  zone: 'top' | 'bottom' | 'left' | 'right'
): Promise<void> {
  const snapshot = await readPaneIdentitySnapshot(page)
  if (!snapshot) {
    throw new Error('moveTerminalPaneByLeafId: no active terminal tab')
  }

  await page.evaluate(
    ({ tabId, sourceLeafId, targetLeafId, zone }) => {
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) {
        throw new Error('moveTerminalPaneByLeafId: active pane manager not ready')
      }
      const sourcePaneId = manager.getNumericIdForLeaf(sourceLeafId)
      const targetPaneId = manager.getNumericIdForLeaf(targetLeafId)
      if (sourcePaneId == null || targetPaneId == null) {
        throw new Error('moveTerminalPaneByLeafId: source or target leaf is not mounted')
      }
      manager.movePane(sourcePaneId, targetPaneId, zone)
    },
    { tabId: snapshot.tabId, sourceLeafId, targetLeafId, zone }
  )
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
  timeoutMs = 10_000,
  charLimit = 4000
): Promise<void> {
  await expect
    .poll(async () => (await getTerminalContent(page, charLimit)).includes(expected), {
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
