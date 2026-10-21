import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

/**
 * Reads a tab's `.xterm-accessibility-tree` text, enabling screen-reader mode on the pane it
 * finds each time it is called.
 *
 * Why re-apply rather than set it once up front: `screenReaderMode` is an option on the xterm
 * instance, and the node it renders belongs to that instance's DOM. A pane that parks and
 * remounts, or rebinds after a reconnect, comes back as a new instance with the option off and
 * no tree — so a one-shot mutation before the read stops producing the very node the read is
 * waiting for, and the wait fails as "element not found" rather than as a content mismatch.
 *
 * Returns null when the pane or the node is not there yet, so a poll keeps retrying.
 */
export function readTerminalAccessibilityText(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane) {
      return null
    }
    if (!pane.terminal.options.screenReaderMode) {
      pane.terminal.options.screenReaderMode = true
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
    const node = document.querySelector(
      `[data-terminal-tab-id="${CSS.escape(id)}"] .xterm-accessibility-tree`
    )
    return node?.textContent ?? null
  }, tabId)
}

export async function expectTerminalAccessibilityText(
  page: Page,
  tabId: string,
  expected: string,
  timeoutMs = 30_000
): Promise<void> {
  await expect
    .poll(() => readTerminalAccessibilityText(page, tabId), {
      timeout: timeoutMs,
      message: `terminal tab ${tabId} never rendered ${expected} in its accessibility tree`
    })
    .toContain(expected)
}
