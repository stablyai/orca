import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { getActiveTabId } from './store'
import { waitForActiveTerminalManager, waitForPaneIdentitySnapshot } from './terminal'

function resolveParkWaitTimeoutMs(parkDelayMs?: number): number {
  const delay = parkDelayMs ?? (Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500)
  return Math.max(20_000, delay * 10)
}

// Why: TerminalPane unmount deletes its entry from window.__paneManagers, so a
// missing manager is the observable signal that the tab's xterm was parked.
export async function waitForTabParked(
  page: Page,
  tabId: string,
  options?: { parkDelayMs?: number }
): Promise<number> {
  const parkWaitStartedAt = Date.now()
  await expect
    .poll(async () => page.evaluate((id) => window.__paneManagers?.get(id) !== undefined, tabId), {
      timeout: resolveParkWaitTimeoutMs(options?.parkDelayMs),
      message: `terminal tab ${tabId} did not park (pane manager still mounted)`
    })
    .toBe(false)
  return Date.now() - parkWaitStartedAt
}

async function createActiveTerminalTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('createActiveTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, worktreeId)

  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: 'newly created terminal tab did not become active'
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  return tabId
}

// Why: #8262 exempts the single most-recently-hidden tab from cold-park to keep
// the just-left view instantly warm, so a lone hidden tab never parks. Opening
// one more tab hides the current view (which then holds that exemption) and
// leaves the older `targetTabId` free to cold-park. Returns waitForTabParked's
// elapsed-ms so callers keep their parking annotations.
export async function parkHiddenTabBehindDecoy(
  page: Page,
  worktreeId: string,
  targetTabId: string,
  options?: { parkDelayMs?: number }
): Promise<number> {
  await createActiveTerminalTab(page, worktreeId)
  return waitForTabParked(page, targetTabId, options)
}
