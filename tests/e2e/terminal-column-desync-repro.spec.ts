/**
 * Repro: xterm <-> PTY column desync.
 *
 * Symptom (observed live, macOS, build 1.4.103): an interactive TUI (Claude
 * Code) renders garbled — ~1 char per line, overlapping text. Ruled out:
 * xterm version, font/letter-spacing, pane width, GPU (DOM renderer).
 *
 * Hypothesis: xterm reflows to the visible width but the PTY's
 * process.stdout.columns is pinned to a stale/tiny value, so the program keeps
 * emitting output sized for the wrong width and xterm faithfully paints
 * garbage. The suspected gate is isRendererPtyResizeAuthoritative() in
 * pty-connection.ts: while a pane is hidden it returns false, so xterm reflows
 * that happen off-screen never reach the PTY, and the resume-time correction
 * (safeFit + transport.resize, pty-connection.ts ~3316) is the only thing that
 * can re-sync. If that correction is missed, the PTY stays stale.
 *
 * The proof is a direct comparison: process.stdout.columns inside the PTY must
 * equal terminal.cols in xterm. This spec drives several scenarios that mimic
 * the real usage and asserts the two match.
 *
 * Reproduces reliably (always on the first mount) when run in isolation:
 *   SKIP_BUILD=1 npx playwright test --config tests/playwright.config.ts \
 *     tests/e2e/terminal-column-desync-repro.spec.ts --project electron-headless \
 *     -g "during initial mount"
 * Observed: the first terminal spawns its PTY at the full window width
 * (e.g. 203 cols) while xterm fits the pane to the real layout width (79 cols);
 * the gap never closes. Under heavy parallel load the timing can shift, so the
 * `-g "during initial mount"` test (serial, reload-looped) is the golden repro.
 */

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

// Why: a generous ceiling so the PTY column probe returns the actual current
// process.stdout.columns instead of waiting for it to drop below a target.
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

/** Read the size the main process reports as APPLIED for a PTY (pty:getSize).
 *  After the applied-size fix this must reflect what the PTY actually took
 *  (process.stdout.columns), not the renderer's last-requested size. */
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

async function closeRightSidebarAndFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return
    }
    store.getState().markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
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

    // Why: the resize chain (ResizeObserver → rAF fit → PTY resize IPC) needs
    // longer than a fixed wait under loaded CI, and the two columns are sampled
    // non-atomically. Poll until they converge — a genuinely dropped resize
    // never converges and still fails, so this keeps the regression guard.
    const expectColumnsInSync = async (label: string): Promise<void> => {
      await expect
        .poll(
          async () => {
            const snap = await readColumnSnapshot(orcaPage, ptyId)
            return snap.ptyCols === snap.xtermCols
              ? 'synced'
              : `pty=${snap.ptyCols} xterm=${snap.xtermCols}`
          },
          { timeout: 30_000, message: `${label}: PTY cols should converge to xterm cols` }
        )
        .toBe('synced')
    }

    // Baseline: a freshly fit terminal should agree with its PTY.
    await expectColumnsInSync('baseline')

    // Shrink the window while the terminal is visible, then widen it. xterm
    // reflows via the ResizeObserver; the PTY must follow.
    await orcaPage.setViewportSize({ width: 760, height: 800 })
    await expectColumnsInSync('after shrink')

    await orcaPage.setViewportSize({ width: 1280, height: 800 })
    await expectColumnsInSync('after widen')
  })

  // Why: guards the applied-size IPC contract the desync fix relies on. The
  // renderer's resume/handoff drift-check compares xterm against pty:getSize; if
  // pty:getSize reports the renderer's last-REQUESTED size (the old intent-only
  // behavior) instead of the size the PTY actually APPLIED, a dropped resize is
  // invisible and the TUI stays garbled. So pty:getSize must equal the real
  // in-PTY process.stdout.columns, not just xterm.
  test('pty:getSize reports the size the PTY actually applied', async ({ orcaPage }) => {
    test.setTimeout(120_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await closeRightSidebarAndFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const ptyId = await settleTerminal(orcaPage)

    await orcaPage.setViewportSize({ width: 900, height: 800 })

    // Why: poll until pty:getSize converges to the real applied columns instead
    // of sampling once after a fixed wait — the resize can still be settling on
    // loaded CI. A getSize that reports intent (not the applied size) never
    // converges to process.stdout.columns and still fails the guard.
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
    await orcaPage.waitForTimeout(400)

    const baseline = await readColumnSnapshot(orcaPage, ptyId)
    expect(baseline.ptyCols).toBe(baseline.xtermCols)

    // Hide the terminal by switching worktrees, resize the window narrow while
    // it is in the background (so isRendererPtyResizeAuthoritative() is false
    // and the off-screen reflow's pty:resize is dropped), then return.
    await switchToWorktree(orcaPage, otherWorktreeId)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.setViewportSize({ width: 720, height: 800 })
    await orcaPage.waitForTimeout(500)
    await switchToWorktree(orcaPage, homeWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await orcaPage.waitForTimeout(600)

    const afterReturn = await readColumnSnapshot(orcaPage, ptyId)
    expect(
      afterReturn.ptyCols,
      `after hidden resize + return, PTY cols (${afterReturn.ptyCols}) should equal xterm cols ` +
        `(${afterReturn.xtermCols}); a stale PTY width is the column-desync bug`
    ).toBe(afterReturn.xtermCols)
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

    // Several hide/resize/show cycles at different widths. Terminal timing bugs
    // need repetition: each cycle is a fresh chance for the resume-time
    // correction to miss and leave the PTY pinned at a stale column count.
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

    // Splitting halves the width of the original pane: xterm reflows to ~half
    // the columns. The PTY must follow, otherwise the existing shell keeps
    // emitting full-width output into a half-width pane.
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

  // Why: the user-reported case — "start a new worktree with the side split
  // panel on". A tab that MOUNTS with a split layout already present (two panes
  // side by side from frame 0) spawns each PTY at the wide window width, then
  // the split equalize narrows each pane AFTER the post-spawn reconcile window
  // has closed. The corrective onResize is dropped by the visibility gate during
  // the mount window, so the PTY stays pinned wide while xterm shows the narrow
  // split width — only a later manual resize re-syncs it ("resizing fixed it").
  // We reproduce the fresh split mount by splitting then reloading: the split
  // layout persists across reload, so the tab remounts with two panes already
  // present, re-running the first-mount spawn for each.
  test('both panes stay PTY-synced when a tab MOUNTS with a split layout present', async ({
    orcaPage
  }) => {
    test.setTimeout(240_000)

    // A single mount only trips the race intermittently, so reload-loop the
    // restored-split first-mount and assert none of the attempts desynced.
    const MOUNT_ATTEMPTS = 6
    const desyncs: { attempt: number; ptyId: string; ptyCols: number; xtermCols: number }[] = []

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await closeRightSidebarAndFeatureTips(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.setViewportSize({ width: 1440, height: 900 })
    await orcaPage.waitForTimeout(300)
    await settleTerminal(orcaPage)

    // Establish the persisted split layout once; reloads below rebuild it.
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneIdentitySnapshot(orcaPage, 2)

    for (let attempt = 0; attempt < MOUNT_ATTEMPTS; attempt += 1) {
      // Re-run the split first-mount path: a wide window, reload so the tab
      // remounts and re-spawns both PTYs at the wide width from the restored
      // split layout, then resize down while the panes are still mounting.
      await orcaPage.setViewportSize({ width: 1440, height: 900 })
      await orcaPage.reload()
      await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await closeRightSidebarAndFeatureTips(orcaPage)
      await ensureTerminalVisible(orcaPage)

      // Resize narrower while the split panes are mounting / their PTYs spawn.
      await orcaPage.setViewportSize({ width: 1180, height: 800 })
      await orcaPage.waitForTimeout(300)

      const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
      // Let layout equalize and the (current) reconcile window run to completion.
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

  // Why: this is the tightest isolation of the real bug. A viewport resize that
  // lands in the terminal's initial mount window — after xterm exists but
  // before the PTY binding/visibility settle — reflows xterm to the new width,
  // but forwardPtyResize drops it (isRendererPtyResizeAuthoritative()===false,
  // or the spawn captures the pre-resize cols and no later resize fires). The
  // PTY stays pinned at the startup width while xterm shows the new width, and
  // nothing re-syncs. A long-output program then prints sized for the stale
  // PTY width into the narrower pane → the garbled "1 char per line" render.
  test('PTY columns stay synced when the window is resized during initial mount', async ({
    orcaPage
  }) => {
    test.setTimeout(240_000)

    // Why: the desync is a race in the *initial* mount window — the first
    // terminal spawns its PTY at the wide default window width, and a resize
    // landing before the PTY binding/visibility settle reflows xterm but is
    // dropped by forwardPtyResize, with no later correction. A single attempt
    // only trips it ~1 in 3 runs, so reload the renderer to re-run the full
    // first-mount sequence each attempt and resize mid-mount. We assert none of
    // the attempts desynced, so a single stale PTY fails the test.
    const MOUNT_ATTEMPTS = 8
    const desyncs: { attempt: number; ptyCols: number; xtermCols: number }[] = []
    for (let attempt = 0; attempt < MOUNT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        // Re-run the first-mount path: a wide window, then reload so the
        // terminal remounts and spawns its PTY at the wide width.
        await orcaPage.setViewportSize({ width: 1440, height: 900 })
        await orcaPage.reload()
        await orcaPage.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
      }
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await closeRightSidebarAndFeatureTips(orcaPage)
      await ensureTerminalVisible(orcaPage)

      // Resize down while the terminal is mounting / the PTY is spawning.
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
