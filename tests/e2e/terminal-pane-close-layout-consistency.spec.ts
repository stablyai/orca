import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

/**
 * Repro hunt for the "ghost blank pane" field incident: a split pane whose PTY
 * and leaf→PTY binding were torn down while the persisted layout `root` kept
 * the leaf, so revisiting the tab materialized a permanently blank pane with
 * no terminal behind it.
 *
 * Field state (workspace remote-issue-2, 2026-07-09): root held 3 leaves,
 * ptyIdsByLeafId held 2, no daemon session for the third — the close/exit ran
 * near a hidden/park boundary. Each test here closes (or exits) a split pane
 * at a different phase of the hidden-view parking lifecycle and asserts the
 * invariant that broke in the field:
 *
 *   leaves(persisted root) === keys(persisted ptyIdsByLeafId) === live panes
 *
 * A failing scenario IS the finding — it pins which boundary loses the layout
 * collapse.
 */

// Why 2000ms: the override shrinks BOTH cold-park delay and hot-retain, and
// the hidden-but-mounted scenario needs the shell exit to land well inside the
// hot-retain window — 500ms let slow shell teardown race past parking and turn
// that scenario into the exits-while-parked one.
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 2_000

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

/**
 * The invariant under hunt. Polls so post-close persists can land, then does a
 * final full read whose diff names the divergence (stale root leaf vs dropped
 * binding vs ghost live pane).
 */
async function expectLayoutConsistent(
  page: Page,
  tabId: string,
  expectedPaneCount: number,
  phase: string,
  deadPtyId?: string
): Promise<void> {
  // Why: polling a shape (not a boolean) makes a timeout print the diverged
  // state — which of root/bindings/live panes went stale is the finding.
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

async function closeLastPaneOnTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    if (!manager) {
      throw new Error(`closeLastPaneOnTab: no mounted pane manager for tab ${tabId}`)
    }
    const target = manager.getPanes().at(-1)
    if (!target) {
      throw new Error('closeLastPaneOnTab: tab has no panes')
    }
    manager.closePane(target.id)
  }, tabId)
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
    state.setActiveTabType('terminal')
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
    state.setActiveTabType('terminal')
    state.setActiveTab(targetTabId)
  }, tabId)
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: `terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
}

// Why: TerminalPane unmount deletes its __paneManagers entry — that absence is
// the observable "parked" signal (same detection as the parking spec).
async function waitForTabParked(page: Page, tabId: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate((id) => window.__paneManagers?.get(id) !== undefined, tabId), {
      timeout: Math.max(20_000, PARKING_DELAY_MS * 10),
      message: `terminal tab ${tabId} did not park (pane manager still mounted)`
    })
    .toBe(false)
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

// Why: every scenario starts from the field shape — a tab whose main pane got
// a split (the "setup pane" analog) that is fully bound and settled.
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
    const { tabId } = await setUpSplitTab(orcaPage)
    await closeLastPaneOnTab(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'close-visible')
  })

  test('close and hide the tab in the same tick', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await orcaPage.evaluate(
      ({ tabId, worktreeId }) => {
        const store = window.__store
        const manager = window.__paneManagers?.get(tabId)
        if (!store || !manager) {
          throw new Error('close+hide: store/manager unavailable')
        }
        const target = manager.getPanes().at(-1)
        if (!target) {
          throw new Error('close+hide: no split pane')
        }
        manager.closePane(target.id)
        // Hide tab A before any deferred post-close work can run.
        const state = store.getState()
        const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
        state.setActiveTab(tab.id)
        state.setActiveTabType('terminal')
      },
      { tabId, worktreeId }
    )
    await orcaPage.waitForTimeout(PARKING_DELAY_MS * 3)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'close-then-hide-same-tick')
  })

  test('close while hidden but still mounted (hot-retain window)', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await createActiveTerminalTab(orcaPage, worktreeId)
    await closeLastPaneOnTab(orcaPage, tabId)
    await waitForTabParked(orcaPage, tabId)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'close-while-hidden-mounted')
  })

  test('close immediately after reveal remount, before panes settle', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await createActiveTerminalTab(orcaPage, worktreeId)
    await waitForTabParked(orcaPage, tabId)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    // Close as soon as the manager exists — panes may still be attaching.
    await orcaPage.evaluate((tabId) => {
      const manager = window.__paneManagers?.get(tabId)
      const target = manager?.getPanes().at(-1)
      if (manager && target) {
        manager.closePane(target.id)
      }
    }, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'close-mid-reveal')
  })

  test('clean visible close survives a later park/reveal cycle', async ({ orcaPage }) => {
    const { worktreeId, tabId } = await setUpSplitTab(orcaPage)
    await closeLastPaneOnTab(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'pre-park close')
    await createActiveTerminalTab(orcaPage, worktreeId)
    await waitForTabParked(orcaPage, tabId)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'post-park-reveal')
  })

  test('split pane shell exits while hidden but still mounted', async ({ orcaPage }) => {
    const { worktreeId, tabId, splitPtyId } = await setUpSplitTab(orcaPage)
    await createActiveTerminalTab(orcaPage, worktreeId)
    // The setup-script analog: the split's shell ends on its own while the
    // tab is hidden-but-mounted.
    await sendToTerminal(orcaPage, splitPtyId, 'exit\r')
    await orcaPage.waitForTimeout(PARKING_DELAY_MS / 2)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    await expectLayoutConsistent(orcaPage, tabId, 1, 'shell-exit-while-hidden-mounted', splitPtyId)
  })

  test('split pane shell exits while the tab is parked', async ({ orcaPage }) => {
    const { worktreeId, tabId, splitPtyId } = await setUpSplitTab(orcaPage)
    await createActiveTerminalTab(orcaPage, worktreeId)
    await waitForTabParked(orcaPage, tabId)
    await sendToTerminal(orcaPage, splitPtyId, 'exit\r')
    await orcaPage.waitForTimeout(PARKING_DELAY_MS)
    await activateTerminalTab(orcaPage, tabId)
    await waitForTabRemounted(orcaPage, tabId)
    // Why: the parked exit is deliberately deferred (no PaneManager to promote
    // siblings) — the reveal remount owns the per-leaf teardown. This asserts
    // that ownership actually resolves instead of leaving a ghost pane.
    await expectLayoutConsistent(orcaPage, tabId, 1, 'shell-exit-while-parked', splitPtyId)
  })
})
