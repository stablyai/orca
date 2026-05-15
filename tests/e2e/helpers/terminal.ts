/* eslint-disable max-lines -- Terminal E2E helpers share one PaneManager-backed path for PTY IO, split actions, and stable pane identity snapshots. */
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type PaneIdentitySnapshot = {
  tabId: string
  activeLeafId: string | null
  panes: {
    numericPaneId: number
    leafId: string
    stablePaneId: string
    datasetLeafId: string | null
    ptyId: string | null
  }[]
  ptyIdsByLeafId: Record<string, string>
}

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

export async function waitForActivePanePtyId(page: Page, timeoutMs = 15_000): Promise<string> {
  await expect
    .poll(
      async () => {
        const tabId = await resolveActiveTabId(page)
        if (!tabId) {
          return null
        }

        return page.evaluate((tabId) => {
          const manager = window.__paneManagers?.get(tabId)
          const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
          return activePane?.container?.dataset?.ptyId ?? null
        }, tabId)
      },
      {
        timeout: timeoutMs,
        message: 'Active terminal pane did not receive a PTY binding'
      }
    )
    .not.toBeNull()

  const tabId = await resolveActiveTabId(page)
  if (!tabId) {
    throw new Error('waitForActivePanePtyId: no active terminal tab')
  }

  const ptyId = await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const activePane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return activePane?.container?.dataset?.ptyId ?? null
  }, tabId)

  if (!ptyId) {
    throw new Error('waitForActivePanePtyId: active pane has no PTY binding')
  }
  return ptyId
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
      // Why: daemon PTY IDs can contain path separators and shell metacharacters.
      // Echo a numeric probe index, then map it back to the opaque ID in Node.
      for (const [index, id] of candidateIds.entries()) {
        window.api.pty.write(String(id), `\x03\x15echo ${marker}_${index}\r`)
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
          const index = Number(matches.at(-1)?.[1] ?? Number.NaN)
          foundPtyId = Number.isInteger(index) ? (candidateIds[index] ?? null) : null
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

export async function waitForPaneIdentitySnapshot(
  page: Page,
  paneCount: number
): Promise<PaneIdentitySnapshot> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPaneIdentitySnapshot(page)
        return Boolean(
          snapshot &&
          snapshot.panes.length === paneCount &&
          snapshot.panes.every(
            (pane) =>
              UUID_RE.test(pane.leafId) &&
              pane.stablePaneId === pane.leafId &&
              pane.datasetLeafId === pane.leafId &&
              pane.ptyId !== null &&
              snapshot.ptyIdsByLeafId[pane.leafId] === pane.ptyId
          )
        )
      },
      {
        timeout: 15_000,
        message: 'Split terminal panes did not settle with UUID leaf-keyed PTY bindings'
      }
    )
    .toBe(true)

  const snapshot = await readPaneIdentitySnapshot(page)
  if (!snapshot) {
    throw new Error('Pane identity snapshot disappeared after settling')
  }
  return snapshot
}

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
