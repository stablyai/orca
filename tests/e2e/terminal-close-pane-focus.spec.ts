/**
 * E2E test for keyboard focus after closing a split terminal pane.
 *
 * User Prompt:
 * - after closing the focused pane, keep typing in the pane that takes over its space
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  focusActiveTerminalInput,
  readTerminalPaneDomLeafOrder,
  resolveActiveTabId,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { closeActivePaneFromKeyboard } from './helpers/terminal-layout-journeys'
import { registerTerminalPaneMountReadiness } from './helpers/terminal-pane-mount-readiness'
import { waitForTerminalOutputForPtyId } from './artificial-opencode-pane-interactions'

const SPLIT_RIGHT_CHORD = process.platform === 'darwin' ? 'Meta+d' : 'Control+Shift+d'

async function waitThreeFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      )
  )
}

/** The leaf whose xterm input holds DOM focus, or null when focus is anywhere else. */
async function readFocusedTerminalLeafId(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((tabId) => {
    const active = document.activeElement
    if (!active?.classList.contains('xterm-helper-textarea')) {
      return null
    }
    const panes = window.__paneManagers?.get(tabId)?.getPanes() ?? []
    return panes.find((pane) => pane.container.contains(active))?.leafId ?? null
  }, tabId)
}

// Why: keep the suite serial so headful pane tests never open multiple Electron windows at once.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal close pane focus', () => {
  registerTerminalPaneMountReadiness()

  test('closing the last of four split panes focuses the neighbor that fills its space', async ({
    orcaPage
  }) => {
    await waitForPaneIdentitySnapshot(orcaPage, 1)
    for (const paneCount of [2, 3, 4]) {
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.press(SPLIT_RIGHT_CHORD)
      await waitForPaneCount(orcaPage, paneCount)
    }
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 4)
    const [, , neighborLeafId, closedLeafId] = await readTerminalPaneDomLeafOrder(orcaPage)
    expect(snapshot.activeLeafId).toBe(closedLeafId)
    const neighborPtyId = neighborLeafId ? snapshot.ptyIdsByLeafId[neighborLeafId] : undefined
    if (!neighborLeafId || !neighborPtyId) {
      throw new Error(`No bound neighbor pane in ${JSON.stringify(snapshot)}`)
    }

    await closeActivePaneFromKeyboard(orcaPage, 4)
    await waitThreeFrames(orcaPage)

    const tabId = await resolveActiveTabId(orcaPage)
    if (!tabId) {
      throw new Error('No active terminal tab after closing a pane')
    }
    expect(await readFocusedTerminalLeafId(orcaPage, tabId)).toBe(neighborLeafId)
    const marker = `CLOSE_FOCUS_${Date.now()}`
    await orcaPage.keyboard.type(`echo ${marker}\r`)
    await waitForTerminalOutputForPtyId(orcaPage, neighborPtyId, marker, 10_000)
  })
})
