/**
 * E2E tests for pane layout chrome: the header split button, the divider that
 * splitting creates, drag resizing, and the space a closed pane gives back.
 *
 * User Prompt:
 * - resizing terminal panes works
 * - closing panes works
 */

import { test, expect } from './helpers/orca-app'
import {
  closeActiveTerminalPane,
  countVisibleTerminalPanes,
  splitActiveTerminalPane,
  waitForPaneIdentitySnapshot,
  waitForPaneCount,
  sendToTerminal
} from './helpers/terminal'
import { readVisiblePaneContents } from './helpers/terminal-pane-geometry'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'

// Why: keep the suite serial so the headful pane tests never ask Playwright to
// open multiple visible Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('Always-on pane header split button hover stays transparent', async ({ orcaPage }) => {
    const splitButton = orcaPage.getByRole('button', { name: 'Split Terminal Right' })
    await expect(splitButton).toBeVisible()
    await splitButton.hover()

    const hoverStyle = await splitButton.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        backgroundColor: style.backgroundColor,
        opacity: style.opacity
      }
    })

    expect(hoverStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(Number(hoverStyle.opacity)).toBeGreaterThan(0.9)
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

  test('@headful resizing split panes forwards only the settled PTY size', async ({ orcaPage }) => {
    await splitActiveTerminalPane(orcaPage, 'vertical')
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 2)
    const ptyIds = snapshot.panes
      .map((pane) => pane.ptyId)
      .filter((ptyId): ptyId is string => Boolean(ptyId))

    for (const ptyId of ptyIds) {
      await sendToTerminal(
        orcaPage,
        ptyId,
        "export PS1='ISSUE2910_PROMPT$ '; export PROMPT=\"$PS1\"; trap 'printf \"\\nISSUE2910_WINCH\\n\"' WINCH; clear; printf 'ISSUE2910_READY\\n'\r"
      )
    }

    await expect
      .poll(
        async () =>
          (await readVisiblePaneContents(orcaPage)).every((content) =>
            content.includes('ISSUE2910_READY')
          ),
        { timeout: 10_000, message: 'Split panes did not receive resize-regression prompt setup' }
      )
      .toBe(true)

    const divider = orcaPage.locator('.pane-divider.is-vertical').first()
    await expect(divider).toBeVisible({ timeout: 3_000 })
    const box = await divider.boundingBox()
    expect(box).not.toBeNull()

    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await orcaPage.mouse.move(startX, startY)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(startX - 350, startY, { steps: 40 })
    await orcaPage.mouse.move(startX + 250, startY, { steps: 40 })
    await orcaPage.mouse.up()
    await orcaPage.waitForTimeout(500)

    const paneContents = await readVisiblePaneContents(orcaPage)
    for (const content of paneContents) {
      const promptRedraws = content.match(/ISSUE2910_PROMPT/g)?.length ?? 0
      const winchNotifications = content.match(/ISSUE2910_WINCH/g)?.length ?? 0
      expect(promptRedraws).toBeLessThanOrEqual(3)
      expect(winchNotifications).toBeLessThanOrEqual(1)
    }
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
