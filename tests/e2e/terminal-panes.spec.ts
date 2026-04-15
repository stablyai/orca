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
  countVisibleTerminalPanes,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent,
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
  ensureTerminalVisible,
} from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'

test.describe('Terminal Panes', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    // Why: ensure we're on a terminal tab before trying to close panes.
    // The worktree-switching test may have left us on a different view.
    await ensureTerminalVisible(orcaPage).catch(() => {})

    // Close any extra split panes back to a single pane
    let paneCount = await countVisibleTerminalPanes(orcaPage)
    while (paneCount > 1) {
      await pressShortcut(orcaPage, 'w')
      await waitForPaneCount(orcaPage, paneCount - 1).catch(() => { /* cleanup best-effort */ })
      paneCount = await countVisibleTerminalPanes(orcaPage)
    }
  })

  /**
   * User Prompt:
   * - terminal panes can be split
   */
  test('can split terminal pane right via keyboard shortcut', async ({ orcaPage }) => {
    const paneCountBefore = await countVisibleTerminalPanes(orcaPage)

    // Cmd/Ctrl+D splits the active terminal pane to the right
    await pressShortcut(orcaPage, 'd')
    await waitForPaneCount(orcaPage, paneCountBefore + 1)

    const paneCountAfter = await countVisibleTerminalPanes(orcaPage)
    expect(paneCountAfter).toBe(paneCountBefore + 1)
  })

  /**
   * User Prompt:
   * - terminal panes can be split
   */
  test('can split terminal pane down via keyboard shortcut', async ({ orcaPage }) => {
    const paneCountBefore = await countVisibleTerminalPanes(orcaPage)

    // Cmd/Ctrl+Shift+D splits the active terminal pane down
    await pressShortcut(orcaPage, 'd', { shift: true })
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
    await pressShortcut(orcaPage, 'd')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    // Focus the newly created pane before closing it.
    // Why: pane close is handled by the terminal-pane keyboard layer, which
    // listens from the focused xterm surface rather than the outer tab shell.
    await orcaPage.locator('.xterm textarea').last().focus()

    // Close the newly created split pane with Cmd/Ctrl+W.
    await pressShortcut(orcaPage, 'w')
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
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 5_000 })
      .toBe(otherId)

    // Switch back to the original worktree
    await switchToWorktree(orcaPage, worktreeId)
    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), { timeout: 5_000 })
      .toBe(worktreeId)

    // The terminal should still contain our marker
    await expect
      .poll(async () => (await getTerminalContent(orcaPage)).includes(marker), { timeout: 5_000 })
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
    await pressShortcut(orcaPage, 'd')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    await expect(orcaPage.locator('.pane-divider.is-vertical').first()).toBeVisible({ timeout: 3_000 })
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
    await pressShortcut(orcaPage, 'd')
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
    await pressShortcut(orcaPage, 'd')
    await waitForPaneCount(orcaPage, panesBefore + 1)

    const panesAfterSplit = await countVisibleTerminalPanes(orcaPage)
    expect(panesAfterSplit).toBeGreaterThanOrEqual(2)

    // Close the active (split) pane
    await pressShortcut(orcaPage, 'w')
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
