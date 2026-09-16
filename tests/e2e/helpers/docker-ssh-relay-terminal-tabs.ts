import { expect, type Page } from '@stablyai/playwright-test'

import { waitForActivePanePtyId, waitForActiveTerminalManager } from './terminal'

/** Add one more terminal tab to a connected remote worktree and wait for it to own a PTY. */
export async function createRemoteTerminalTab(page: Page, worktreeId: string): Promise<void> {
  const tabId = await page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, worktreeId)
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeTabId ?? null), {
      timeout: 10_000
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
}

export async function readRemoteTerminalTabs(
  page: Page,
  worktreeId: string
): Promise<{ id: string; ptyId: string | null }[]> {
  return page.evaluate(
    (id) =>
      (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => ({
        id: tab.id,
        ptyId: tab.ptyId
      })),
    worktreeId
  )
}
