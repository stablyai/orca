import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

// Re-enable screenReaderMode on each read: parking or reconnect can replace the xterm instance and its accessibility DOM.
// Return null while the pane/tree is absent so callers keep polling.
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
