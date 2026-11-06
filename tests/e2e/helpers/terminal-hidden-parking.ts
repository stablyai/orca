import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { getActiveTabId } from './store'
import { waitForActiveTerminalManager, waitForPaneIdentitySnapshot } from './terminal'

function resolveParkWaitTimeoutMs(parkDelayMs?: number): number {
  const delay = parkDelayMs ?? (Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500)
  return Math.max(20_000, delay * 10)
}

// PaneManager unregisters on unmount, making its absence the observable parking signal.
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
    state.setActiveTabType('terminal', store.getState().activeWorktreeId)
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

// #8262 exempts the most recently hidden tab: use two decoys for an active target, one for an already-hidden target.
export async function parkHiddenTabBehindDecoy(
  page: Page,
  worktreeId: string,
  targetTabId: string,
  options?: { parkDelayMs?: number }
): Promise<number> {
  if ((await getActiveTabId(page)) === targetTabId) {
    await createActiveTerminalTab(page, worktreeId)
  }
  await createActiveTerminalTab(page, worktreeId)
  return waitForTabParked(page, targetTabId, options)
}
