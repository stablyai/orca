import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  requestTerminalPaneClose,
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'
import { readMainLayout } from './helpers/main-terminal-layout'
import { REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT } from '../../src/renderer/src/constants/terminal'

// Ghost-pane repro: remote-issue-2 (2026-07-09) retained three root leaves but only two bindings/live PTYs near a hide/park close boundary.
// Close or exit at each lifecycle phase and require persisted root leaves === persisted binding keys === live panes.

// Use 2000ms for cold/hot retention: 500ms lets slow shell teardown race past mounted-hidden into parked-exit coverage.
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 2_000

// Why exit 0: zsh startup on macOS can leave $? at 1, and a non-zero exit stays behind the exited card on purpose.
const CLEAN_SHELL_EXIT = 'exit 0\r'

test.use({
  orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(PARKING_DELAY_MS) }
})

type ParkingDebugWindow = Window & {
  __terminalParkingDebug?: { parkDelayMs?: number }
}

async function skipUnlessParkingWired(page: Page): Promise<void> {
  const deadline = Date.now() + 2_000
  let present = await page.evaluate(
    () => (window as ParkingDebugWindow).__terminalParkingDebug !== undefined
  )
  while (!present && Date.now() < deadline) {
    await page.waitForTimeout(250)
    present = await page.evaluate(
      () => (window as ParkingDebugWindow).__terminalParkingDebug !== undefined
    )
  }
  test.skip(!present, 'terminal hidden view parking wiring is not compiled in')
}

type LayoutConsistency = {
  rootLeafIds: string[]
  boundLeafIds: string[]
  boundPtyIds: string[]
  livePaneCount: number | null
  hasManager: boolean
  domPaneCount: number
}

async function readLayoutConsistency(page: Page, tabId: string): Promise<LayoutConsistency> {
  return page.evaluate((tabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store unavailable')
    }
    const layout = store.getState().terminalLayoutsByTabId[tabId]
    const rootLeafIds: string[] = []
    type LayoutNode =
      | { type: 'leaf'; leafId: string }
      | { type: 'split'; first: LayoutNode; second: LayoutNode }
    const walk = (node: LayoutNode | null | undefined): void => {
      if (!node) {
        return
      }
      if (node.type === 'leaf') {
        rootLeafIds.push(node.leafId)
        return
      }
      walk(node.first)
      walk(node.second)
    }
    walk((layout?.root ?? null) as LayoutNode | null)
    const manager = window.__paneManagers?.get(tabId)
    const managerPanes = manager?.getPanes?.() ?? null
    const paneElements = managerPanes ? new Set(managerPanes.map((pane) => pane.container)) : null
    return {
      rootLeafIds,
      boundLeafIds: Object.keys(layout?.ptyIdsByLeafId ?? {}),
      boundPtyIds: Object.values(layout?.ptyIdsByLeafId ?? {}),
      livePaneCount: managerPanes ? managerPanes.length : null,
      hasManager: manager !== undefined,
      domPaneCount: paneElements
        ? Array.from(document.querySelectorAll<HTMLElement>('.pane[data-leaf-id]')).filter(
            (element) => paneElements.has(element)
          ).length
        : 0
    }
  }, tabId)
}

// Poll persistence then read the full shape so failures distinguish stale root leaves, missing bindings and ghost live panes.
async function expectLayoutConsistent(
  page: Page,
  tabId: string,
  expectedPaneCount: number,
  phase: string,
  deadPtyId?: string
): Promise<void> {
  // Poll a shape so timeout prints the divergent root/binding/live state.
  await expect
    .poll(
      async () => {
        const state = await readLayoutConsistency(page, tabId)
        return {
          hasManager: state.hasManager,
          livePaneCount: state.livePaneCount,
          domPaneCount: state.domPaneCount,
          rootLeafCount: state.rootLeafIds.length,
          boundLeafCount: state.boundLeafIds.length,
          unboundRootLeafIds: state.rootLeafIds.filter(
            (leafId) => !state.boundLeafIds.includes(leafId)
          ),
          deadPtyStillBound: deadPtyId ? state.boundPtyIds.includes(deadPtyId) : false
        }
      },
      {
        timeout: 15_000,
        message: `[${phase}] layout did not settle to ${expectedPaneCount} consistent pane(s)`
      }
    )
    .toEqual({
      hasManager: true,
      livePaneCount: expectedPaneCount,
      domPaneCount: expectedPaneCount,
      rootLeafCount: expectedPaneCount,
      boundLeafCount: expectedPaneCount,
      unboundRootLeafIds: [],
      deadPtyStillBound: false
    })
}

/** Main's stored panes for the tab are the window's: the close the window drew reached main. */
async function expectMainHoldsWindowPanes(
  page: Page,
  worktreeId: string,
  tabId: string,
  phase: string
): Promise<void> {
  const { rootLeafIds } = await readLayoutConsistency(page, tabId)
  await expect
    .poll(
      async () =>
        (await readMainLayout(page, worktreeId)).find(([id]) => id === tabId)?.[1] ?? null,
      { timeout: 15_000, message: `[${phase}] main's stored panes differ from the window's` }
    )
    .toEqual(rootLeafIds)
}

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('createActiveTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
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

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
    state.setActiveTab(targetTabId)
  }, tabId)
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: `terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
}

async function waitForTabRemounted(page: Page, tabId: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate((id) => window.__paneManagers?.get(id) !== undefined, tabId), {
      timeout: 15_000,
      message: `terminal tab ${tabId} did not remount on reveal`
    })
    .toBe(true)
}

type SplitTabSetup = {
  worktreeId: string
  tabId: string
  splitLeafId: string
  splitPtyId: string
}

// Seed the field shape: main plus fully bound/settled split pane.
async function setUpSplitTab(page: Page): Promise<SplitTabSetup> {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await skipUnlessParkingWired(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  const tabId = await getActiveTabId(page)
  if (!tabId) {
    throw new Error('setUpSplitTab: no active terminal tab')
  }
  await splitActiveTerminalPane(page, 'vertical')
  const snapshot = await waitForPaneIdentitySnapshot(page, 2)
  const splitPane = snapshot.panes.at(-1)
  if (!splitPane?.ptyId) {
    throw new Error('setUpSplitTab: split pane did not bind a PTY')
  }
  return { worktreeId, tabId, splitLeafId: splitPane.leafId, splitPtyId: splitPane.ptyId }
}

test.describe('terminal pane close vs hidden/park lifecycle keeps layout consistent', () => {
  test('control: close while visible', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await requestTerminalPaneClose(orcaPage, tabId, 'last')
    await expectLayoutConsistent(orcaPage, tabId, 1, 'close-visible')
    await expectMainHoldsWindowPanes(orcaPage, worktreeId, tabId, 'close-visible')
  })

  test('close and hide the tab in the same tick', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await orcaPage.evaluate(
      ({ tabId, worktreeId, closeEvent }) => {
        const store = window.__store
        const manager = window.__paneManagers?.get(tabId)
        if (!store || !manager) {
          throw new Error('close+hide: store/manager unavailable')
        }
        const target = manager.getPanes().at(-1)
        if (!target) {
          throw new Error('close+hide: no split pane')
        }
        // The user's close (see requestTerminalPaneClose), sent without waiting for it.
        manager.setActivePane(target.id, { focus: false })
        window.dispatchEvent(new CustomEvent(closeEvent, { detail: { tabId } }))
        // Hide tab A before any deferred post-close work can run.
        const state = store.getState()
        const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
        state.setActiveTab(tab.id)
        state.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
      },
      { tabId, worktreeId, closeEvent: REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT }
    )
    await orcaPage.waitForTimeout(PARKING_DELAY_MS * 3)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'close-then-hide-same-tick')
    await expectMainHoldsWindowPanes(orcaPage, worktreeId, tabId, 'close-then-hide-same-tick')
  })

  test('close while hidden but still mounted (hot-retain window)', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await createActiveTerminalTab(orcaPage, worktreeId)
    await requestTerminalPaneClose(orcaPage, tabId, 'last')
    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
      parkDelayMs: PARKING_DELAY_MS
    })
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'close-while-hidden-mounted')
    await expectMainHoldsWindowPanes(orcaPage, worktreeId, tabId, 'close-while-hidden-mounted')
  })

  test('close immediately after reveal remount, before panes settle', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await createActiveTerminalTab(orcaPage, worktreeId)
    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
      parkDelayMs: PARKING_DELAY_MS
    })
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    // Close as soon as the manager exists — panes may still be attaching.
    await requestTerminalPaneClose(orcaPage, tabId, 'last')
    await expectLayoutConsistent(orcaPage, tabId, 1, 'close-mid-reveal')
    await expectMainHoldsWindowPanes(orcaPage, worktreeId, tabId, 'close-mid-reveal')
  })

  test('clean visible close survives a later park/reveal cycle', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await requestTerminalPaneClose(orcaPage, tabId, 'last')
    await expectLayoutConsistent(orcaPage, tabId, 1, 'pre-park close')
    await createActiveTerminalTab(orcaPage, worktreeId)
    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
      parkDelayMs: PARKING_DELAY_MS
    })
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'post-park-reveal')
    await expectMainHoldsWindowPanes(orcaPage, worktreeId, tabId, 'post-park-reveal')
  })

  test('split pane shell exits while hidden but still mounted', async ({ orcaPage }) => {
    const { worktreeId, tabId, splitPtyId } = await setUpSplitTab(orcaPage)
    await createActiveTerminalTab(orcaPage, worktreeId)
    // Model setup-script shell exit while hidden but still mounted.
    await sendToTerminal(orcaPage, splitPtyId, CLEAN_SHELL_EXIT)
    await orcaPage.waitForTimeout(PARKING_DELAY_MS / 2)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'shell-exit-while-hidden-mounted', splitPtyId)
    await expectMainHoldsWindowPanes(orcaPage, worktreeId, tabId, 'shell-exit-while-hidden-mounted')
  })

  test('split pane shell exits while the tab is parked', async ({ orcaPage }) => {
    const { worktreeId, tabId, splitPtyId } = await setUpSplitTab(orcaPage)
    await createActiveTerminalTab(orcaPage, worktreeId)
    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
      parkDelayMs: PARKING_DELAY_MS
    })
    await sendToTerminal(orcaPage, splitPtyId, CLEAN_SHELL_EXIT)
    await orcaPage.waitForTimeout(PARKING_DELAY_MS)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    // Parked exits defer sibling promotion to reveal’s remounted PaneManager; require per-leaf teardown to finish without a ghost pane.
    await expectLayoutConsistent(orcaPage, tabId, 1, 'shell-exit-while-parked', splitPtyId)
    await expectMainHoldsWindowPanes(orcaPage, worktreeId, tabId, 'shell-exit-while-parked')
  })
})
