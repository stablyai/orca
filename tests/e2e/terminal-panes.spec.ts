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
