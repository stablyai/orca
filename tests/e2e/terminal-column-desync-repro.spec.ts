// Reproduce stale PTY columns after mount/hide/split while xterm fits the actual container; compare xterm cols to in-PTY process.stdout.columns.
// Build 1.4.103 showed first-spawn window width persisting against narrow pane width; repeat initial-mount reloads to expose timing-sensitive dropped resize.

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { waitForPtyColumnsAtMost } from './terminal-column-probes'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

// Use a generous probe ceiling so it reports actual columns instead of waiting for a target width.
const READ_ANY_COLS = 100_000

/** Read xterm's authoritative column count for the active terminal pane. */
async function readRenderedTerminalCols(page: Page): Promise<number> {
  return page.evaluate(() => {
    const store = window.__store
    const state = store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.terminal?.cols ?? 0
  })
}

/** Read process.stdout.columns as seen by the program inside the PTY. */
async function readPtyCols(page: Page, ptyId: string): Promise<number> {
  return waitForPtyColumnsAtMost(page, ptyId, READ_ANY_COLS, 30_000)
}

/** Read xterm cols for the pane bound to a specific PTY id. */
async function readRenderedColsForPty(page: Page, ptyId: string): Promise<number> {
  return page.evaluate((ptyId) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      for (const pane of manager.getPanes?.() ?? []) {
        if (pane.container?.dataset?.ptyId === ptyId) {
          return pane.terminal?.cols ?? 0
        }
      }
    }
    return 0
  }, ptyId)
}

// Require pty:getSize to report applied PTY size, not the renderer’s last requested intent.
async function readReportedPtyCols(page: Page, ptyId: string): Promise<number> {
  return page.evaluate(async (ptyId) => {
    const size = await window.api?.pty?.getSize?.(ptyId)
    return size?.cols ?? 0
  }, ptyId)
}

type ColumnSnapshot = { xtermCols: number; ptyCols: number }

async function readColumnSnapshot(page: Page, ptyId: string): Promise<ColumnSnapshot> {
  const xtermCols = await readRenderedTerminalCols(page)
  const ptyCols = await readPtyCols(page, ptyId)
  return { xtermCols, ptyCols }
}

// Poll non-atomic xterm/PTY reads through ResizeObserver → rAF fit → resize IPC; dropped resize never converges.
async function expectColumnsInSync(page: Page, ptyId: string, label: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const snap = await readColumnSnapshot(page, ptyId)
        return snap.ptyCols === snap.xtermCols
          ? 'synced'
          : `pty=${snap.ptyCols} xterm=${snap.xtermCols}`
      },
      { timeout: 30_000, message: `${label}: PTY cols should converge to xterm cols` }
    )
    .toBe('synced')
}

async function closeRightSidebarAndFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return
    }
    store
      .getState()
      .markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation', 'agent-session-search'])
    if (store.getState().rightSidebarOpen) {
      store.getState().setRightSidebarOpen(false)
    }
  })
}

async function settleTerminal(page: Page): Promise<string> {
  await waitForActiveTerminalManager(page, 30_000)
  const ptyId = await waitForActivePanePtyId(page)
  await waitForPtyShellEcho(page, ptyId, 15_000)
  return ptyId
}

test.describe('Terminal column desync repro', () => {
  test('PTY columns stay in sync with xterm across a visible resize', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await closeRightSidebarAndFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const ptyId = await settleTerminal(orcaPage)

    await expectColumnsInSync(orcaPage, ptyId, 'baseline')

    await orcaPage.setViewportSize({ width: 760, height: 800 })
    await expectColumnsInSync(orcaPage, ptyId, 'after shrink')

    await orcaPage.setViewportSize({ width: 1280, height: 800 })
    await expectColumnsInSync(orcaPage, ptyId, 'after widen')
  })

  // Compare getSize to in-PTY columns: intent-only reporting hides dropped resizes from resume/handoff drift correction.
  test('pty:getSize reports the size the PTY actually applied', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await closeRightSidebarAndFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const ptyId = await settleTerminal(orcaPage)

    await orcaPage.setViewportSize({ width: 900, height: 800 })

    // Poll applied size through loaded CI’s async resize chain.
    await expect
      .poll(
        async () => {
          const ptyCols = await readPtyCols(orcaPage, ptyId)
          const reportedCols = await readReportedPtyCols(orcaPage, ptyId)
          return reportedCols === ptyCols ? 'match' : `reported=${reportedCols} pty=${ptyCols}`
        },
        {
          timeout: 30_000,
          message:
            'pty:getSize must converge to the applied PTY columns (process.stdout.columns) ' +
            'so the drift-check can detect a dropped resize'
        }
      )
      .toBe('match')
  })

  test('PTY columns re-sync after the terminal is resized while hidden', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    const otherWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== homeWorktreeId)
    test.skip(!otherWorktreeId, 'hidden-resize repro needs the seeded secondary worktree')
    if (!otherWorktreeId) {
      return
    }

    await closeRightSidebarAndFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const ptyId = await settleTerminal(orcaPage)
    await orcaPage.setViewportSize({ width: 1280, height: 800 })
    await expectColumnsInSync(orcaPage, ptyId, 'before hidden resize')

    // Resize while hidden so normal forwarding is gated, then test resume correction.
    await switchToWorktree(orcaPage, otherWorktreeId)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.setViewportSize({ width: 720, height: 800 })
    await orcaPage.waitForTimeout(500)
    await switchToWorktree(orcaPage, homeWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expectColumnsInSync(orcaPage, ptyId, 'after hidden resize + return')
  })

  test('PTY columns re-sync after repeated background resizes', async ({ orcaPage }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    const homeWorktreeId = await waitForActiveWorktree(orcaPage)
    const otherWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== homeWorktreeId)
    test.skip(
      !otherWorktreeId,
      'repeated background-resize repro needs the seeded secondary worktree'
    )
    if (!otherWorktreeId) {
      return
    }

    await closeRightSidebarAndFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const ptyId = await settleTerminal(orcaPage)

    // Repeat hide/resize/show widths to expose missed resume correction.
    const widths = [700, 1320, 640, 1180, 600]
    for (const [index, width] of widths.entries()) {
      await switchToWorktree(orcaPage, otherWorktreeId)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.setViewportSize({ width, height: 800 })
      await orcaPage.waitForTimeout(350)
      await switchToWorktree(orcaPage, homeWorktreeId)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await orcaPage.waitForTimeout(500)

      const snapshot = await readColumnSnapshot(orcaPage, ptyId)
      expect(
        snapshot.ptyCols,
        `cycle ${index} (width ${width}): PTY cols (${snapshot.ptyCols}) should equal xterm cols ` +
          `(${snapshot.xtermCols})`
      ).toBe(snapshot.xtermCols)
    }
  })

  test('both panes keep PTY columns synced after a vertical split reparent', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await closeRightSidebarAndFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.setViewportSize({ width: 1280, height: 800 })
    await orcaPage.waitForTimeout(300)
    const firstPtyId = await settleTerminal(orcaPage)

    const baseline = await readColumnSnapshot(orcaPage, firstPtyId)
    expect(baseline.ptyCols).toBe(baseline.xtermCols)

    // Split must resize the original PTY with its narrowed xterm pane.
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await expect
      .poll(
        async () => {
          const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
          return snapshot.panes
            .map((pane) => pane.ptyId)
            .filter((ptyId): ptyId is string => Boolean(ptyId))
        },
        { timeout: 30_000, message: 'vertical split should produce two PTY-backed panes' }
      )
      .toHaveLength(2)
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)

    for (const pane of snapshot.panes) {
      const ptyId = pane.ptyId
      expect(ptyId, 'split pane should be bound to a PTY').toBeTruthy()
      if (!ptyId) {
        continue
      }
      const ptyCols = await readPtyCols(orcaPage, ptyId)
      const xtermCols = await readRenderedColsForPty(orcaPage, ptyId)
      expect(
        ptyCols,
        `after split, pane ${ptyId} PTY cols (${ptyCols}) should equal its xterm cols (${xtermCols})`
      ).toBe(xtermCols)
    }
  })

  // Reload a persisted split so both panes mount narrow after wide spawn; the post-spawn reconciliation/visibility race must not pin PTYs wide.
  test('both panes stay PTY-synced when a tab MOUNTS with a split layout present', async ({
    orcaPage
  }) => {
    test.setTimeout(240_000)

    // Repeat restored-split first mounts because the dropped-resize race is intermittent.
    const MOUNT_ATTEMPTS = 6
    const desyncs: { attempt: number; ptyId: string; ptyCols: number; xtermCols: number }[] = []

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await closeRightSidebarAndFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.setViewportSize({ width: 1440, height: 900 })
    await orcaPage.waitForTimeout(300)
    await settleTerminal(orcaPage)

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneIdentitySnapshot(orcaPage, 2)

    for (let attempt = 0; attempt < MOUNT_ATTEMPTS; attempt += 1) {
      // Reload at wide width, then shrink during split mount/PTy spawn.
      await orcaPage.setViewportSize({ width: 1440, height: 900 })
      await orcaPage.reload()
      await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await closeRightSidebarAndFeatureTips(orcaPage)
      await ensureTerminalVisible(orcaPage)

      await orcaPage.setViewportSize({ width: 1180, height: 800 })
      await orcaPage.waitForTimeout(300)

      const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
      await orcaPage.waitForTimeout(900)

      for (const pane of snapshot.panes) {
        const ptyId = pane.ptyId
        expect(ptyId, 'restored split pane should be bound to a PTY').toBeTruthy()
        if (!ptyId) {
          continue
        }
        const ptyCols = await readPtyCols(orcaPage, ptyId)
        const xtermCols = await readRenderedColsForPty(orcaPage, ptyId)
        if (ptyCols !== xtermCols) {
          desyncs.push({ attempt, ptyId, ptyCols, xtermCols })
        }
      }
    }

    expect(
      desyncs,
      `PTY columns desynced from xterm on a restored-split mount (${desyncs.length} pane(s) ` +
        `across ${MOUNT_ATTEMPTS} attempts). A PTY pinned at the wide startup width while xterm ` +
        `reflowed to the narrower split width is the column-desync bug that garbles interactive ` +
        `TUIs: ${JSON.stringify(desyncs)}`
    ).toEqual([])
  })

  // Resize after xterm exists but before binding/visibility settles; a gated or stale spawn resize must eventually reconcile PTY columns.
  test('PTY columns stay synced when the window is resized during initial mount', async ({
    orcaPage
  }) => {
    test.setTimeout(240_000)

    // Repeat full first-mount reloads; the race previously reproduced about one in three attempts, so any stale PTY fails.
    const MOUNT_ATTEMPTS = 8
    const desyncs: { attempt: number; ptyCols: number; xtermCols: number }[] = []
    for (let attempt = 0; attempt < MOUNT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await orcaPage.setViewportSize({ width: 1440, height: 900 })
        await orcaPage.reload()
        await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      }
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await closeRightSidebarAndFeatureTips(orcaPage)
      await ensureTerminalVisible(orcaPage)

      await orcaPage.setViewportSize({ width: 1280, height: 800 })
      await orcaPage.waitForTimeout(300)

      const ptyId = await settleTerminal(orcaPage)
      await orcaPage.waitForTimeout(700)

      const snapshot = await readColumnSnapshot(orcaPage, ptyId)
      if (snapshot.ptyCols !== snapshot.xtermCols) {
        desyncs.push({ attempt, ptyCols: snapshot.ptyCols, xtermCols: snapshot.xtermCols })
      }
    }

    expect(
      desyncs,
      `PTY columns desynced from xterm on ${desyncs.length}/${MOUNT_ATTEMPTS} mount attempts. ` +
        `A PTY pinned at the wider startup width while xterm reflowed narrower is the ` +
        `column-desync bug that garbles interactive TUIs: ${JSON.stringify(desyncs)}`
    ).toEqual([])
  })
})
