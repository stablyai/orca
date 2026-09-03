/**
 * Shared probes for GH #10205: a deliberately slept workspace must stay cold.
 * Drives the shipping sleep path (sidebar context menu) and reads both the
 * renderer's live PTY model and host truth.
 */
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { ensureTerminalVisible } from './store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './terminal'

export type WorkspaceSample = {
  livePtyCount: number
  tabCount: number
  tabIds: string[]
  mountedTabIds: string[]
  tabPtyHints: (string | null)[]
}

export function rowLocator(page: Page, worktreeId: string): Locator {
  return page
    .locator(
      `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(worktreeId)}]`
    )
    .first()
}

export async function readWorkspaceSample(
  page: Page,
  worktreeId: string
): Promise<WorkspaceSample> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    const tabs = state.tabsByWorktree[id] ?? []
    const tabIds = new Set(tabs.map((tab) => tab.id))
    const managers = window.__paneManagers
    return {
      livePtyCount: tabs.reduce(
        (count, tab) => count + (state.ptyIdsByTabId[tab.id]?.length ?? 0),
        0
      ),
      tabCount: tabs.length,
      tabIds: tabs.map((tab) => tab.id),
      mountedTabIds: managers
        ? Array.from(managers.keys()).filter((tabId) => tabIds.has(tabId))
        : [],
      tabPtyHints: tabs.map((tab) => tab.ptyId ?? null)
    }
  }, worktreeId)
}

/** Host-side truth: a revived workspace shows a freshly created live session here. */
export async function readHostLiveTerminalCount(page: Page, worktreeId: string): Promise<number> {
  return (await page.evaluate(async (id) => {
    const result = await window.api.runtime.call({
      method: 'terminal.list',
      params: { worktree: `id:${id}`, requireFreshPtyLiveness: true }
    })
    if (!result.ok) {
      throw new Error(result.error.message)
    }
    return (result.result as { totalCount: number }).totalCount
  }, worktreeId)) as number
}

/** Connect-verdict lines (REATTACH / ATTACH / FRESH SPAWN / SKIP SPAWN) for one workspace. */
export async function readConnectDiagnostics(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    const target = globalThis as unknown as Record<string, unknown>
    const diag = (target.__ptyConnectDiag as string[] | undefined) ?? []
    const tabIds = new Set((state?.tabsByWorktree[id] ?? []).map((tab) => tab.id))
    // Pane ids restart at 1 per worktree, so a verdict line is attributed to the
    // tab named by the most recent connect line for that same pane id.
    const tabByPaneId = new Map<string, string>()
    const owned: string[] = []
    for (const line of diag) {
      const connect = /^pane=(\d+) tab=(\S+)/.exec(line)
      if (connect) {
        tabByPaneId.set(connect[1], connect[2])
        if (tabIds.has(connect[2])) {
          owned.push(line)
        }
        continue
      }
      const verdict = /^pane=(\d+) ->/.exec(line)
      if (verdict) {
        const tabId = tabByPaneId.get(verdict[1])
        if (tabId && tabIds.has(tabId)) {
          owned.push(line)
        }
      }
    }
    return owned
  }, worktreeId)
}

export async function giveWorkspaceALivePty(page: Page, worktreeId: string): Promise<string> {
  await page.evaluate((id) => {
    window.__store?.getState().setActiveWorktree(id)
  }, worktreeId)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  return waitForActivePanePtyId(page, 30_000)
}

/** The shipping sleep path: right-click the sidebar row, click "Sleep". */
export async function sleepWorkspaceViaSidebar(page: Page, worktreeId: string): Promise<void> {
  const row = rowLocator(page, worktreeId)
  await expect(row).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  const scope = row.locator('[data-worktree-context-menu-scope="worktree"]').first()
  const target = (await scope.count()) > 0 ? scope : row
  await target.click({ button: 'right' })
  const sleepItem = page.getByRole('menuitem', { name: 'Sleep', exact: true }).first()
  await expect(sleepItem).toBeVisible()
  await sleepItem.click()
}

export async function activateWorkspaceByClick(page: Page, worktreeId: string): Promise<void> {
  const row = rowLocator(page, worktreeId)
  await expect(row).toBeVisible()
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeWorktreeId ?? null), {
      timeout: 10_000,
      message: `sidebar click did not activate ${worktreeId}`
    })
    .toBe(worktreeId)
}
