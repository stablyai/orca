/**
 * Geometry and serialized-content readers for visible terminal panes.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { waitForPaneIdentitySnapshot } from './terminal'

export async function readVisibleXtermContainerBox(
  page: Page
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page
    .locator('.xterm:visible')
    .first()
    .evaluate((xterm) => {
      const container = xterm.closest('.xterm-container')
      if (!(container instanceof HTMLElement)) {
        throw new Error('No visible xterm container found')
      }
      const rect = container.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
}

export function expectTerminalToReserveTitleSpace(
  actual: { x: number; y: number; width: number; height: number },
  expected: { x: number; y: number; width: number; height: number }
): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThan(1)
  expect(Math.abs(actual.width - expected.width)).toBeLessThan(1)
  expect(actual.y - expected.y).toBeGreaterThan(10)
  expect(expected.height - actual.height).toBeGreaterThan(10)
}

export async function readVisiblePaneContents(page: Page): Promise<string[]> {
  const snapshot = await waitForPaneIdentitySnapshot(page, 2)
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    return (
      manager
        ?.getPanes()
        .map((pane) => pane.serializeAddon?.serialize?.({ scrollback: 200 }) ?? '') ?? []
    )
  }, snapshot.tabId)
}
