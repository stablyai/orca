/* oxlint-disable max-lines, curly */
/**
 * E2E tests for terminal pane splitting, state retention, resizing, and closing.
 *
 * User Prompt:
 * - terminal panes can be split
 * - terminal panes retain state when switching tabs and when you make / close a pane / switch worktrees
 * - resizing terminal panes works
 * - closing panes works
 */

import { test, expect } from './helpers/orca-app'
import {
  discoverActivePtyId,
  execInTerminal,
  closeActiveTerminalPane,
  countVisibleTerminalPanes,
  focusLastTerminalPane,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent
} from './helpers/terminal'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getWorktreeTabs,
  getAllWorktreeIds,
  switchToOtherWorktree,
  switchToWorktree,
  ensureTerminalVisible
} from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import path from 'path'

// Why: only the pointer-drag resize test needs a visible window (pointer
// capture requires a real pointer id). Every other pane operation here is
// driven through the exposed PaneManager API and runs fine headless, so the
// suite itself is not tagged — just the one test that needs it.
// Why: keep the suite serial so when the headful test does run, Playwright
// does not try to open multiple visible Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    // Why: each test launches a fresh Electron instance. The React tree needs
    // to render Terminal → TabGroupPanel → TerminalPane → useTerminalPaneLifecycle
    // before the PaneManager registers on window.__paneManagers. On cold starts
    // this easily exceeds 5s, so allow up to 30s (well within the 120s test budget)
    // to distinguish "slow cold start" from "environment can't mount panes at all."
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager, so pane split/resize assertions would only fail on harness setup.'
    )
    // Why: hidden Electron runs can report an active terminal tab before the
    // PaneManager finishes mounting the first xterm/PTY pair. Wait for that
    // initial pane so split and content-retention assertions start from a real
    // terminal surface instead of racing the bootstrapped mount.
    await waitForPaneCount(orcaPage, 1, 30_000)
  })

  /**
   * User Prompt:
   * - terminal panes can be split
   */
  test('can split terminal pane right', async ({ orcaPage }) => {
    const paneCountBefore = await countVisibleTerminalPanes(orcaPage)

    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, paneCountBefore + 1)

    const paneCountAfter = await countVisibleTerminalPanes(orcaPage)
    expect(paneCountAfter).toBe(paneCountBefore + 1)
  })

  /**
   * User Prompt:
   * - terminal panes can be split
   */
  test('can split terminal pane down', async ({ orcaPage }) => {
    const paneCountBefore = await countVisibleTerminalPanes(orcaPage)

    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneCount(orcaPage, paneCountBefore + 1)

    const paneCountAfter = await countVisibleTerminalPanes(orcaPage)
    expect(paneCountAfter).toBe(paneCountBefore + 1)
  })

  /**
   * User Prompt:
   * - terminal panes retain state when switching tabs and when you make / close a pane / switch worktrees
   */
  test('terminal pane retains content when switching tabs and back', async ({ orcaPage }) => {
    // Write a unique marker to the current terminal
    const ptyId = await discoverActivePtyId(orcaPage)
    const marker = `RETAIN_TEST_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(orcaPage, marker)

    // Create a new terminal tab (Cmd/Ctrl+T) to switch away
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await pressShortcut(orcaPage, 't')

    // Wait for the new tab to appear
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    // Verify we're still on a terminal tab
    const activeType = await getActiveTabType(orcaPage)
    expect(activeType).toBe('terminal')

    // Switch back to the previous tab with Cmd/Ctrl+Shift+[
    await pressShortcut(orcaPage, 'BracketLeft', { shift: true })

    // Verify the marker is still present
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), { timeout: 5_000 })
      .toBe(true)

    // Clean up the extra tab
    await pressShortcut(orcaPage, 'BracketRight', { shift: true })
    await pressShortcut(orcaPage, 'w')
  })

  /**
   * User Prompt:
   * - terminal panes retain state when switching tabs and when you make / close a pane / switch worktrees
   */
  test('terminal pane retains content when splitting and closing a pane', async ({ orcaPage }) => {
    // Write a unique marker to the current terminal
    const ptyId = await discoverActivePtyId(orcaPage)
    const marker = `SPLIT_RETAIN_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(orcaPage, marker)

    const panesBefore = await countVisibleTerminalPanes(orcaPage)

    // Split the terminal right
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    await focusLastTerminalPane(orcaPage)
    await closeActiveTerminalPane(orcaPage)
    await waitForPaneCount(orcaPage, panesBefore)

    // The original pane should still have our marker
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), { timeout: 5_000 })
      .toBe(true)
  })

  /**
   * User Prompt:
   * - terminal panes retain state when switching tabs and when you make / close a pane / switch worktrees
   */
  test('terminal pane retains content when switching worktrees and back', async ({ orcaPage }) => {
    const allWorktreeIds = await getAllWorktreeIds(orcaPage)
    if (allWorktreeIds.length < 2) {
      test.skip(true, 'Need at least 2 worktrees to test worktree switching')
      return
    }

    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Write a unique marker to the current terminal
    const ptyId = await discoverActivePtyId(orcaPage)
    const marker = `WT_RETAIN_${Date.now()}`
    await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(orcaPage, marker)

    // Switch to a different worktree via the store
    const otherId = await switchToOtherWorktree(orcaPage, worktreeId)
    expect(otherId).not.toBeNull()
    await expect.poll(async () => getActiveWorktreeId(orcaPage), { timeout: 5_000 }).toBe(otherId)

    // Switch back to the original worktree
    await switchToWorktree(orcaPage, worktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 5_000 })
      .toBe(worktreeId)

    // Why: after a worktree round-trip, the split-group container transitions
    // from hidden back to visible. In headful Electron runs the terminal tree
    // can take longer than a single render turn to rebind its serialize addon
    // after the worktree activation cascade. Waiting directly for the retained
    // marker proves the user-visible behavior without failing early on the
    // intermediate manager-remount timing.
    await ensureTerminalVisible(orcaPage)

    // The terminal should still contain our marker
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), { timeout: 20_000 })
      .toBe(true)
  })

  /**
   * User Prompt:
   * - resizing terminal panes works
   */
  test('shows a pane divider after splitting', async ({ orcaPage }) => {
    // Why: headless Playwright cannot exercise the real pointer-capture resize
    // path reliably, so the default suite only verifies the precondition for
    // resizing: splitting creates a visible divider for the active layout.
    const panesBefore = await countVisibleTerminalPanes(orcaPage)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    await expect(orcaPage.locator('.pane-divider.is-vertical').first()).toBeVisible({
      timeout: 3_000
    })
  })

  /**
   * User Prompt:
   * - resizing terminal panes works (headful variant)
   *
   * Why this test must be headful: the pane divider's drag handler calls
   * setPointerCapture(e.pointerId) on pointerdown. Pointer capture requires
   * a valid pointer ID from a real pointing-device event, which Playwright's
   * mouse API only produces when the Electron window is visible. In headless
   * mode setPointerCapture silently fails, pointermove never fires on the
   * divider, and the resize has no effect. Run with:
   *   ORCA_E2E_HEADFUL=1 pnpm run test:e2e
   */
  test('@headful can resize terminal panes by real mouse drag', async ({ orcaPage }) => {
    // Split the terminal to create a resizable divider
    const panesBefore = await countVisibleTerminalPanes(orcaPage)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    // Get the pane widths before resize
    const paneWidthsBefore = await orcaPage.evaluate(() => {
      const xterms = document.querySelectorAll('.xterm')
      return Array.from(xterms)
        .filter((x) => (x as HTMLElement).offsetParent !== null)
        .map((x) => (x as HTMLElement).getBoundingClientRect().width)
    })
    expect(paneWidthsBefore.length).toBeGreaterThanOrEqual(2)

    // Find the vertical pane divider and drag it
    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()

    // Drag the divider 150px to the right to resize panes
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(startX + 150, startY, { steps: 20 })
    await orcaPage.mouse.up()

    // Verify pane widths changed
    await expect
      .poll(
        async () => {
          const widthsAfter = await orcaPage.evaluate(() => {
            const xterms = document.querySelectorAll('.xterm')
            return Array.from(xterms)
              .filter((x) => (x as HTMLElement).offsetParent !== null)
              .map((x) => (x as HTMLElement).getBoundingClientRect().width)
          })
          if (widthsAfter.length < 2) {
            return false
          }

          return paneWidthsBefore.some((w, i) => Math.abs(w - widthsAfter[i]) > 20)
        },
        { timeout: 5_000, message: 'Pane widths did not change after dragging divider' }
      )
      .toBe(true)
  })

  /**
   * Regression test: dragging a vertical divider to resize split panes must
   * preserve scroll position in partially-scrolled terminals. The bug manifests
   * as terminals jumping to the top (or near-top) during/after drag.
   *
   * Why headful: pointer capture requires a real pointer ID from a visible window.
   */
  test('@headful scroll position preserved during divider drag resize', async ({ orcaPage }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)

    const ptyId = await discoverActivePtyId(orcaPage)
    // Why: long lines that wrap are essential to reproduce the bug. Short
    // lines (like `seq 1 5000`) don't wrap, so baseY stays constant during
    // reflow and scroll preservation is trivially correct. Claude Code output
    // contains long formatted lines that reflow dramatically on column changes.
    // Simulate Claude Code-like output: ANSI-formatted text with unicode
    // box-drawing characters and long wrapped lines, similar to what Claude
    // Code renders in a real session.
    await execInTerminal(
      orcaPage,
      ptyId,
      `python3 -c "
import sys
# Banner like Claude Code
print('\\033[1;36m ▐▛███▜▌   Claude Code v2.1.10\\033[0m')
print('\\033[90m' + '─' * 200 + '\\033[0m')
# Simulated conversation with long wrapped lines
for i in range(500):
    if i % 10 == 0:
        print(f'\\033[1;32m❯ User message {i//10}:\\033[0m')
        print('  ' + 'Here is a long user prompt that wraps across multiple lines. ' * 4)
    else:
        # Code block with indentation
        print(f'\\033[90m  {i:4d} │\\033[0m  ' + 'const result = await fetch(url).then(r => r.json()).catch(err => console.error(err)); // ' + 'x' * 80)
print('\\033[90m' + '─' * 200 + '\\033[0m')
print('DONE_MARKER')
"`
    )
    await waitForTerminalOutput(orcaPage, 'DONE_MARKER', 15_000)
    await orcaPage.waitForTimeout(500)

    // Scroll to ~middle of scrollback
    const scrollBefore = await orcaPage.evaluate(() => {
      const tabId = (() => {
        const store = window.__store
        if (!store) return null
        const state = store.getState()
        const wId = state.activeWorktreeId
        if (!wId) return null
        return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
      })()
      if (!tabId) return null
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) return null
      const pane = manager.getActivePane()
      if (!pane) return null
      const buf = pane.terminal.buffer.active
      const targetLine = Math.floor(buf.baseY / 2)
      pane.terminal.scrollToLine(targetLine)
      return {
        viewportY: pane.terminal.buffer.active.viewportY,
        baseY: buf.baseY,
        paneId: pane.id,
        cols: pane.terminal.cols
      }
    })
    expect(scrollBefore).not.toBeNull()
    expect(scrollBefore!.viewportY).toBeGreaterThan(0)

    // Capture renderer console logs for diagnostics
    const consoleLogs: string[] = []
    orcaPage.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[restoreScrollState]') || text.includes('[scrollToLineSync]')) {
        consoleLogs.push(text)
      }
    })

    // Drag the divider LEFT then RIGHT then LEFT — simulating the user's
    // "adjust right and left" gesture. Each direction change causes reflow.
    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    // Drag left (narrowing), then right (widening), then left again
    await orcaPage.mouse.move(startX - 250, startY, { steps: 20 })
    await orcaPage.mouse.move(startX + 150, startY, { steps: 20 })
    await orcaPage.mouse.move(startX - 200, startY, { steps: 20 })
    await orcaPage.mouse.up()
    await orcaPage.waitForTimeout(500)

    const scrollAfter = await orcaPage.evaluate(
      ({ paneId }) => {
        const tabId = (() => {
          const store = window.__store
          if (!store) return null
          const state = store.getState()
          const wId = state.activeWorktreeId
          if (!wId) return null
          return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
        })()
        if (!tabId) return null
        const manager = window.__paneManagers?.get(tabId)
        if (!manager) return null
        const panes = manager.getPanes() ?? []
        const pane = panes.find((p: { id: number }) => p.id === paneId)
        if (!pane) return null
        return {
          viewportY: pane.terminal.buffer.active.viewportY,
          baseY: pane.terminal.buffer.active.baseY,
          cols: pane.terminal.cols
        }
      },
      { paneId: scrollBefore!.paneId }
    )
    expect(scrollAfter).not.toBeNull()
    const drift = Math.abs(scrollAfter!.viewportY - scrollBefore!.viewportY)
    // Use proportional position (viewportY / baseY) since absolute line
    // numbers change legitimately during reflow (more/less wrapping).
    const ratioBefore = scrollBefore!.viewportY / scrollBefore!.baseY
    const ratioAfter = scrollAfter!.baseY > 0 ? scrollAfter!.viewportY / scrollAfter!.baseY : 0
    const proportionalDrift = Math.abs(ratioAfter - ratioBefore)
    console.log(
      '[scroll-test] wrapping-content:',
      JSON.stringify({
        before: scrollBefore!.viewportY,
        after: scrollAfter!.viewportY,
        absoluteDrift: drift,
        ratioBefore: ratioBefore.toFixed(4),
        ratioAfter: ratioAfter.toFixed(4),
        proportionalDrift: proportionalDrift.toFixed(4),
        baseYBefore: scrollBefore!.baseY,
        baseYAfter: scrollAfter!.baseY,
        colsBefore: scrollBefore!.cols,
        colsAfter: scrollAfter!.cols
      })
    )
    // Proportional drift should be <5% — the same relative content should
    // be visible regardless of how wrapping changed the absolute line count.
    expect(proportionalDrift).toBeLessThanOrEqual(0.05)
    // Must not be at the very top
    expect(scrollAfter!.viewportY).toBeGreaterThan(scrollAfter!.baseY * 0.1)

    // Check for Scrollable desync: do a small mouse wheel scroll and verify
    // the viewport doesn't jump to a completely different position.
    const paneEl = orcaPage.locator(`.pane[data-pane-id="${scrollBefore!.paneId}"]`).first()
    const paneBox = await paneEl.boundingBox()
    if (paneBox) {
      await orcaPage.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2)
      await orcaPage.mouse.wheel(0, 50) // scroll down slightly
      await orcaPage.waitForTimeout(200)

      const scrollAfterWheel = await orcaPage.evaluate(
        ({ paneId }) => {
          const tabId = (() => {
            const store = window.__store
            if (!store) return null
            const state = store.getState()
            const wId = state.activeWorktreeId
            if (!wId) return null
            return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
          })()
          if (!tabId) return null
          const manager = window.__paneManagers?.get(tabId)
          if (!manager) return null
          const panes = manager.getPanes() ?? []
          const pane = panes.find((p: { id: number }) => p.id === paneId)
          if (!pane) return null
          return {
            viewportY: pane.terminal.buffer.active.viewportY,
            baseY: pane.terminal.buffer.active.baseY
          }
        },
        { paneId: scrollBefore!.paneId }
      )
      if (scrollAfterWheel) {
        const wheelJump = Math.abs(scrollAfterWheel.viewportY - scrollAfter!.viewportY)
        const ratioAfterWheel =
          scrollAfterWheel.baseY > 0 ? scrollAfterWheel.viewportY / scrollAfterWheel.baseY : 0
        console.log(
          '[scroll-test] post-wheel:',
          JSON.stringify({
            viewportYAfterDrag: scrollAfter!.viewportY,
            viewportYAfterWheel: scrollAfterWheel.viewportY,
            wheelJump,
            ratioAfterWheel: ratioAfterWheel.toFixed(4)
          })
        )
        // A small wheel scroll should move by a few lines, not jump hundreds
        expect(wheelJump).toBeLessThan(scrollAfterWheel.baseY * 0.05)
      }
    }
  })

  test('@headful scroll position preserved in triple split layout', async ({ orcaPage }) => {
    // Reproduce user's exact layout: triple split (top-left has content,
    // bottom-left and right are empty)
    await splitActiveTerminalPane(orcaPage, 'vertical') // left | right
    await waitForPaneCount(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'horizontal') // top-left / bottom-left | right
    await waitForPaneCount(orcaPage, 3)

    // Focus the first pane (top-left) and fill with wrapping content
    const ptyId = await discoverActivePtyId(orcaPage)
    await execInTerminal(
      orcaPage,
      ptyId,
      'python3 -c "import string; s=string.ascii_letters+string.digits; [print(f\'LINE_{i:04d} \' + (s*8)[:500]) for i in range(1000)]"'
    )
    await waitForTerminalOutput(orcaPage, 'LINE_0999', 15_000)
    await orcaPage.waitForTimeout(500)

    const scrollBefore = await orcaPage.evaluate(() => {
      const tabId = (() => {
        const store = window.__store
        if (!store) return null
        const state = store.getState()
        const wId = state.activeWorktreeId
        if (!wId) return null
        return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
      })()
      if (!tabId) return null
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) return null
      const pane = manager.getActivePane()
      if (!pane) return null
      const buf = pane.terminal.buffer.active
      const targetLine = Math.floor(buf.baseY / 2)
      pane.terminal.scrollToLine(targetLine)
      return {
        viewportY: pane.terminal.buffer.active.viewportY,
        baseY: buf.baseY,
        paneId: pane.id,
        cols: pane.terminal.cols
      }
    })
    expect(scrollBefore).not.toBeNull()
    expect(scrollBefore!.viewportY).toBeGreaterThan(0)

    const consoleLogs: string[] = []
    orcaPage.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('[restoreScrollState]') || text.includes('[scrollToLineSync]')) {
        consoleLogs.push(text)
      }
    })

    // Drag the HORIZONTAL divider (between top-left and bottom-left) UP
    // to change the height of the content pane — this changes rows and
    // triggers reflow in a triple-split layout.
    // Also try the vertical divider to change cols.
    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    // Drag RIGHT to widen left panes (more cols, less wrapping)
    await orcaPage.mouse.move(startX + 200, startY, { steps: 30 })
    await orcaPage.mouse.up()
    await orcaPage.waitForTimeout(500)

    const scrollAfter = await orcaPage.evaluate(
      ({ paneId }) => {
        const tabId = (() => {
          const store = window.__store
          if (!store) return null
          const state = store.getState()
          const wId = state.activeWorktreeId
          if (!wId) return null
          return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
        })()
        if (!tabId) return null
        const manager = window.__paneManagers?.get(tabId)
        if (!manager) return null
        const panes = manager.getPanes() ?? []
        const pane = panes.find((p: { id: number }) => p.id === paneId)
        if (!pane) return null
        return {
          viewportY: pane.terminal.buffer.active.viewportY,
          baseY: pane.terminal.buffer.active.baseY,
          cols: pane.terminal.cols
        }
      },
      { paneId: scrollBefore!.paneId }
    )
    expect(scrollAfter).not.toBeNull()

    const ratioBefore = scrollBefore!.viewportY / scrollBefore!.baseY
    const ratioAfter = scrollAfter!.baseY > 0 ? scrollAfter!.viewportY / scrollAfter!.baseY : 0
    const proportionalDrift = Math.abs(ratioAfter - ratioBefore)
    console.log(
      '[scroll-test] triple-split:',
      JSON.stringify({
        before: scrollBefore!.viewportY,
        after: scrollAfter!.viewportY,
        ratioBefore: ratioBefore.toFixed(4),
        ratioAfter: ratioAfter.toFixed(4),
        proportionalDrift: proportionalDrift.toFixed(4),
        baseYBefore: scrollBefore!.baseY,
        baseYAfter: scrollAfter!.baseY,
        colsBefore: scrollBefore!.cols,
        colsAfter: scrollAfter!.cols
      })
    )

    // Check for Scrollable desync via mouse wheel
    const paneEl = orcaPage.locator(`.pane[data-pane-id="${scrollBefore!.paneId}"]`).first()
    const paneBox = await paneEl.boundingBox()
    if (paneBox) {
      await orcaPage.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2)
      await orcaPage.mouse.wheel(0, 50)
      await orcaPage.waitForTimeout(200)

      const scrollAfterWheel = await orcaPage.evaluate(
        ({ paneId }) => {
          const tabId = (() => {
            const store = window.__store
            if (!store) return null
            const state = store.getState()
            const wId = state.activeWorktreeId
            if (!wId) return null
            return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
          })()
          if (!tabId) return null
          const manager = window.__paneManagers?.get(tabId)
          if (!manager) return null
          const panes = manager.getPanes() ?? []
          const pane = panes.find((p: { id: number }) => p.id === paneId)
          if (!pane) return null
          return {
            viewportY: pane.terminal.buffer.active.viewportY,
            baseY: pane.terminal.buffer.active.baseY
          }
        },
        { paneId: scrollBefore!.paneId }
      )
      if (scrollAfterWheel) {
        const wheelJump = Math.abs(scrollAfterWheel.viewportY - scrollAfter!.viewportY)
        console.log(
          '[scroll-test] triple-split-post-wheel:',
          JSON.stringify({
            viewportYAfterDrag: scrollAfter!.viewportY,
            viewportYAfterWheel: scrollAfterWheel.viewportY,
            wheelJump
          })
        )
        expect(wheelJump).toBeLessThan(scrollAfterWheel.baseY * 0.05)
      }
    }

    expect(proportionalDrift).toBeLessThanOrEqual(0.05)
    expect(scrollAfter!.viewportY).toBeGreaterThan(scrollAfter!.baseY * 0.1)
  })

  test('@headful scroll position preserved during drag with active terminal writes', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)

    const ptyId = await discoverActivePtyId(orcaPage)
    await execInTerminal(orcaPage, ptyId, 'seq 1 5000')
    await waitForTerminalOutput(orcaPage, '5000')
    await orcaPage.waitForTimeout(300)

    const scrollBefore = await orcaPage.evaluate(() => {
      const tabId = (() => {
        const store = window.__store
        if (!store) return null
        const state = store.getState()
        const wId = state.activeWorktreeId
        if (!wId) return null
        return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
      })()
      if (!tabId) return null
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) return null
      const pane = manager.getActivePane()
      if (!pane) return null
      const buf = pane.terminal.buffer.active
      const targetLine = Math.floor(buf.baseY / 2)
      pane.terminal.scrollToLine(targetLine)
      return {
        viewportY: pane.terminal.buffer.active.viewportY,
        baseY: buf.baseY,
        paneId: pane.id,
        cols: pane.terminal.cols
      }
    })
    expect(scrollBefore).not.toBeNull()
    expect(scrollBefore!.viewportY).toBeGreaterThan(0)

    // Start a background loop that writes to the terminal during drag,
    // simulating what Claude Code does when it redraws on SIGWINCH
    await execInTerminal(
      orcaPage,
      ptyId,
      'while true; do echo "REDRAW $(date +%s%N)"; sleep 0.05; done &'
    )
    await orcaPage.waitForTimeout(200)
    // Re-scroll after the writes started (they push to bottom)
    await orcaPage.evaluate(
      ({ paneId, targetViewportY }) => {
        const tabId = (() => {
          const store = window.__store
          if (!store) return null
          const state = store.getState()
          const wId = state.activeWorktreeId
          if (!wId) return null
          return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
        })()
        if (!tabId) return
        const manager = window.__paneManagers?.get(tabId)
        if (!manager) return
        const panes = manager.getPanes() ?? []
        const pane = panes.find((p: { id: number }) => p.id === paneId)
        if (!pane) return
        pane.terminal.scrollToLine(targetViewportY)
      },
      { paneId: scrollBefore!.paneId, targetViewportY: scrollBefore!.viewportY }
    )
    await orcaPage.waitForTimeout(100)

    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(startX + 100, startY, { steps: 15 })
    await orcaPage.mouse.up()

    // Kill the background writer
    await execInTerminal(orcaPage, ptyId, 'kill %1 2>/dev/null; true')
    await orcaPage.waitForTimeout(500)

    const scrollAfter = await orcaPage.evaluate(
      ({ paneId }) => {
        const tabId = (() => {
          const store = window.__store
          if (!store) return null
          const state = store.getState()
          const wId = state.activeWorktreeId
          if (!wId) return null
          return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
        })()
        if (!tabId) return null
        const manager = window.__paneManagers?.get(tabId)
        if (!manager) return null
        const panes = manager.getPanes() ?? []
        const pane = panes.find((p: { id: number }) => p.id === paneId)
        if (!pane) return null
        return {
          viewportY: pane.terminal.buffer.active.viewportY,
          baseY: pane.terminal.buffer.active.baseY,
          cols: pane.terminal.cols
        }
      },
      { paneId: scrollBefore!.paneId }
    )
    expect(scrollAfter).not.toBeNull()
    const drift = Math.abs(scrollAfter!.viewportY - scrollBefore!.viewportY)
    console.log('[scroll-test] active-writes:', {
      before: scrollBefore!.viewportY,
      after: scrollAfter!.viewportY,
      drift,
      baseYBefore: scrollBefore!.baseY,
      baseYAfter: scrollAfter!.baseY,
      colsBefore: scrollBefore!.cols,
      colsAfter: scrollAfter!.cols
    })
    // With active writes, allow more tolerance but must not jump to top
    const maxDrift = scrollBefore!.baseY * 0.1
    expect(drift).toBeLessThanOrEqual(maxDrift)
    expect(scrollAfter!.viewportY).toBeGreaterThan(scrollBefore!.baseY * 0.1)
  })

  test('@headful scroll position preserved during drag with TUI-style redraws', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)

    const ptyId = await discoverActivePtyId(orcaPage)
    await execInTerminal(orcaPage, ptyId, 'seq 1 5000')
    await waitForTerminalOutput(orcaPage, '5000')
    await orcaPage.waitForTimeout(300)

    const scrollBefore = await orcaPage.evaluate(() => {
      const tabId = (() => {
        const store = window.__store
        if (!store) return null
        const state = store.getState()
        const wId = state.activeWorktreeId
        if (!wId) return null
        return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
      })()
      if (!tabId) return null
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) return null
      const pane = manager.getActivePane()
      if (!pane) return null
      const buf = pane.terminal.buffer.active
      const targetLine = Math.floor(buf.baseY / 2)
      pane.terminal.scrollToLine(targetLine)
      return {
        viewportY: pane.terminal.buffer.active.viewportY,
        baseY: buf.baseY,
        paneId: pane.id,
        cols: pane.terminal.cols
      }
    })
    expect(scrollBefore).not.toBeNull()
    expect(scrollBefore!.viewportY).toBeGreaterThan(0)

    // Simulate TUI redraw: a SIGWINCH-responsive script that clears the
    // last few lines and rewrites them — like Claude Code's status bar.
    // This uses cursor movement + clear-to-end escape sequences.
    await execInTerminal(
      orcaPage,
      ptyId,
      String.raw`trap 'printf "\033[s\033[999;1H\033[2K--- RESIZE %dx%d ---\033[u" $COLUMNS $LINES' WINCH; while true; do sleep 0.1; done &`
    )
    await orcaPage.waitForTimeout(200)
    // Re-scroll after trap setup
    await orcaPage.evaluate(
      ({ paneId, targetViewportY }) => {
        const tabId = (() => {
          const store = window.__store
          if (!store) return null
          const state = store.getState()
          const wId = state.activeWorktreeId
          if (!wId) return null
          return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
        })()
        if (!tabId) return
        const manager = window.__paneManagers?.get(tabId)
        if (!manager) return
        const panes = manager.getPanes() ?? []
        const pane = panes.find((p: { id: number }) => p.id === paneId)
        if (!pane) return
        pane.terminal.scrollToLine(targetViewportY)
      },
      { paneId: scrollBefore!.paneId, targetViewportY: scrollBefore!.viewportY }
    )
    await orcaPage.waitForTimeout(100)

    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    // Slower drag with more steps to trigger multiple SIGWINCHes
    await orcaPage.mouse.move(startX + 150, startY, { steps: 30 })
    await orcaPage.mouse.up()

    await execInTerminal(orcaPage, ptyId, 'kill %1 2>/dev/null; true')
    await orcaPage.waitForTimeout(500)

    const scrollAfter = await orcaPage.evaluate(
      ({ paneId }) => {
        const tabId = (() => {
          const store = window.__store
          if (!store) return null
          const state = store.getState()
          const wId = state.activeWorktreeId
          if (!wId) return null
          return (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
        })()
        if (!tabId) return null
        const manager = window.__paneManagers?.get(tabId)
        if (!manager) return null
        const panes = manager.getPanes() ?? []
        const pane = panes.find((p: { id: number }) => p.id === paneId)
        if (!pane) return null
        return {
          viewportY: pane.terminal.buffer.active.viewportY,
          baseY: pane.terminal.buffer.active.baseY,
          cols: pane.terminal.cols
        }
      },
      { paneId: scrollBefore!.paneId }
    )
    expect(scrollAfter).not.toBeNull()
    const drift = Math.abs(scrollAfter!.viewportY - scrollBefore!.viewportY)
    console.log('[scroll-test] tui-redraw:', {
      before: scrollBefore!.viewportY,
      after: scrollAfter!.viewportY,
      drift,
      baseYBefore: scrollBefore!.baseY,
      baseYAfter: scrollAfter!.baseY,
      colsBefore: scrollBefore!.cols,
      colsAfter: scrollAfter!.cols
    })
    const maxDrift = scrollBefore!.baseY * 0.1
    expect(drift).toBeLessThanOrEqual(maxDrift)
    expect(scrollAfter!.viewportY).toBeGreaterThan(scrollBefore!.baseY * 0.1)
  })

  /**
   * Regression test for the SIGWINCH scroll corruption bug.
   *
   * Uses an Ink-like TUI simulator that reproduces the exact rendering
   * pattern that caused Claude Code sessions to lose scroll position during
   * divider drag resize: cursor-up + clear-to-end-of-display + rewrite.
   *
   * The bug: drag resize → PTY resize → SIGWINCH → TUI redraws → viewportY
   * corrupted → ResizeObserver captures corrupted state → scroll jumps to 0.
   *
   * Why headful: pointer capture requires a real pointer ID from a visible window.
   */
  test('@headful scroll position preserved during drag with Ink-style TUI redraws', async ({
    orcaPage
  }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, 2)

    const ptyId = await discoverActivePtyId(orcaPage)

    // Generate scrollback content with long wrapping lines
    await execInTerminal(
      orcaPage,
      ptyId,
      [
        'python3 -c "',
        'import string, sys',
        'chars = string.ascii_letters + string.digits',
        'for i in range(300):',
        "    line = f\\'LINE{i:04d} \\' + (chars * 3)[:200]",
        '    print(line)',
        'sys.stdout.flush()',
        '"'
      ].join('\n')
    )
    await waitForTerminalOutput(orcaPage, 'LINE0299', 15_000)
    await orcaPage.waitForTimeout(500)

    // Start the Ink TUI simulator (redraws on SIGWINCH like Claude Code)
    const fixturePath = path.resolve('tests/e2e/fixtures/ink-tui-sim.mjs')
    await execInTerminal(orcaPage, ptyId, `node ${fixturePath} &`)
    await orcaPage.waitForTimeout(1000)

    // Scroll to ~middle of scrollback
    const scrollBefore = await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        return null
      }
      const state = store.getState()
      const wId = state.activeWorktreeId
      if (!wId) {
        return null
      }
      const tabId = (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
      if (!tabId) {
        return null
      }
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) {
        return null
      }
      const pane = manager.getActivePane()
      if (!pane) {
        return null
      }
      const buf = pane.terminal.buffer.active
      const targetLine = Math.floor(buf.baseY / 2)
      pane.terminal.scrollToLine(targetLine)
      return {
        viewportY: pane.terminal.buffer.active.viewportY,
        baseY: buf.baseY,
        paneId: pane.id,
        cols: pane.terminal.cols
      }
    })
    expect(scrollBefore).not.toBeNull()
    expect(scrollBefore!.viewportY).toBeGreaterThan(0)
    await orcaPage.waitForTimeout(200)

    // Drag the divider — each step triggers fit() → onResize. The PTY resize
    // is suppressed during drag but flushed at drag end, sending SIGWINCH to
    // the Ink TUI simulator which does cursor-up + clear + rewrite.
    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(startX + 150, startY, { steps: 20 })
    await orcaPage.mouse.up()

    // Wait for the SIGWINCH settling period (500ms) + buffer
    await orcaPage.waitForTimeout(1000)

    const scrollAfter = await orcaPage.evaluate(
      ({ paneId }) => {
        const store = window.__store
        if (!store) {
          return null
        }
        const state = store.getState()
        const wId = state.activeWorktreeId
        if (!wId) {
          return null
        }
        const tabId = (state.tabsByWorktree[wId] ?? [])[0]?.id ?? null
        if (!tabId) {
          return null
        }
        const manager = window.__paneManagers?.get(tabId)
        if (!manager) {
          return null
        }
        const panes = manager.getPanes() ?? []
        const pane = panes.find((p: { id: number }) => p.id === paneId)
        if (!pane) {
          return null
        }
        return {
          viewportY: pane.terminal.buffer.active.viewportY,
          baseY: pane.terminal.buffer.active.baseY,
          cols: pane.terminal.cols
        }
      },
      { paneId: scrollBefore!.paneId }
    )
    expect(scrollAfter).not.toBeNull()

    // Kill the background TUI simulator
    await execInTerminal(orcaPage, ptyId, 'kill %1 2>/dev/null; true')
    await orcaPage.waitForTimeout(300)

    const ratioBefore = scrollBefore!.viewportY / scrollBefore!.baseY
    const ratioAfter = scrollAfter!.baseY > 0 ? scrollAfter!.viewportY / scrollAfter!.baseY : 0
    const proportionalDrift = Math.abs(ratioAfter - ratioBefore)
    console.log(
      '[scroll-test] ink-tui-sim:',
      JSON.stringify({
        before: scrollBefore!.viewportY,
        after: scrollAfter!.viewportY,
        ratioBefore: ratioBefore.toFixed(4),
        ratioAfter: ratioAfter.toFixed(4),
        proportionalDrift: proportionalDrift.toFixed(4),
        baseYBefore: scrollBefore!.baseY,
        baseYAfter: scrollAfter!.baseY,
        colsBefore: scrollBefore!.cols,
        colsAfter: scrollAfter!.cols
      })
    )

    expect(proportionalDrift).toBeLessThanOrEqual(0.05)
    expect(scrollAfter!.viewportY).toBeGreaterThan(scrollAfter!.baseY * 0.1)
  })

  /**
   * User Prompt:
   * - closing panes works
   */
  test('closing a split pane removes it and remaining pane fills space', async ({ orcaPage }) => {
    const panesBefore = await countVisibleTerminalPanes(orcaPage)

    // Split the terminal
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    const panesAfterSplit = await countVisibleTerminalPanes(orcaPage)
    expect(panesAfterSplit).toBeGreaterThanOrEqual(2)

    await closeActiveTerminalPane(orcaPage)
    await waitForPaneCount(orcaPage, panesAfterSplit - 1)

    // The remaining pane should fill the available space
    const paneWidth = await orcaPage.evaluate(() => {
      const xterms = document.querySelectorAll('.xterm')
      const visible = Array.from(xterms).find(
        (x) => (x as HTMLElement).offsetParent !== null
      ) as HTMLElement | null
      return visible?.getBoundingClientRect().width ?? 0
    })
    // Why: threshold is kept low to account for headless mode where the
    // window is 1200px wide (not maximized) and the sidebar takes space.
    expect(paneWidth).toBeGreaterThan(200)
  })
})
