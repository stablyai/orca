import { expect } from '@stablyai/playwright-test'
import type { Locator, Page } from '@stablyai/playwright-test'
import { getActiveTabId } from './store'

export const SORTABLE_TAB = '[data-testid="sortable-tab"]'

// Why: split groups and hidden worktrees keep extra tab bars mounted, so the "+" has to come from
// the active group's strip; the pre-layout titlebar fallback has no strip to scope to.
async function activeTabBarRoot(page: Page): Promise<Locator> {
  const groupId = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!worktreeId) {
      return null
    }
    return (
      state?.activeGroupIdByWorktree?.[worktreeId] ??
      state?.groupsByWorktree?.[worktreeId]?.[0]?.id ??
      null
    )
  })
  if (!groupId) {
    return page.locator('body')
  }
  const strip = page.locator(`[data-tab-group-strip-id="${groupId}"]`)
  return (await strip.count()) > 0 ? strip : page.locator('body')
}

export async function createTerminalTabFromMenu(page: Page): Promise<string> {
  const tabBar = await activeTabBarRoot(page)
  const tabsBefore = await tabBar.locator(SORTABLE_TAB).count()
  const activeBefore = await getActiveTabId(page)

  await tabBar.getByRole('button', { name: 'New tab' }).click()
  await page
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click()

  await expect
    .poll(() => tabBar.locator(SORTABLE_TAB).count(), {
      timeout: 10_000,
      message: 'New Terminal did not render a new tab in the tab bar'
    })
    .toBe(tabsBefore + 1)

  await expect
    .poll(
      async () => {
        const current = await getActiveTabId(page)
        return Boolean(current && current !== activeBefore)
      },
      { timeout: 10_000, message: 'New Terminal did not become the active tab' }
    )
    .toBe(true)

  const tabId = await getActiveTabId(page)
  if (!tabId) {
    throw new Error('New Terminal tab id was unavailable after creation')
  }
  return tabId
}
