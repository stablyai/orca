/**
 * E2E tests for the Tasks page.
 *
 * Verifies that opening the tasks view renders correctly and that the
 * repo selector, preset tabs, and close affordance are all present.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, getStoreState } from './helpers/store'

async function openTasksPage(page: Parameters<typeof getStoreState>[0]): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    store?.getState().openTaskPage()
  })
}

test.describe('Tasks page', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('opening the tasks view renders the tasks UI', async ({ orcaPage }) => {
    await openTasksPage(orcaPage)

    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('tasks')

    // Titlebar label, close button, and preset tabs should all render.
    await expect(orcaPage.getByRole('button', { name: 'Close tasks' })).toBeVisible({
      timeout: 10_000
    })
    await expect(orcaPage.getByRole('button', { name: 'GitHub', exact: true })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'All', exact: true })).toBeVisible()
    await expect(orcaPage.getByPlaceholder(/GitHub search/i)).toBeVisible()
  })

  test('closing the tasks page returns to the previous view', async ({ orcaPage }) => {
    const previousView = await getStoreState<string>(orcaPage, 'activeView')

    await openTasksPage(orcaPage)
    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe('tasks')
    // Sanity: the tasks UI actually painted before we close it.
    await expect(orcaPage.getByRole('button', { name: 'Close tasks' })).toBeVisible()

    await orcaPage.getByRole('button', { name: 'Close tasks' }).click()

    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'), { timeout: 5_000 })
      .toBe(previousView)
    // Why: the load-bearing check is that the previous view's DOM actually
    // re-rendered — a store-only `activeView` assertion would pass even if the
    // terminal/editor surface had silently stopped mounting. `.xterm` is the
    // stable class xterm.js emits on every live terminal pane; if the
    // previous view was terminal (by far the common case in E2E setup), that
    // element must be visible. Tasks-close also hides the "Close tasks"
    // button regardless of previous view, so we assert that too.
    await expect(orcaPage.getByRole('button', { name: 'Close tasks' })).toHaveCount(0)
    if (previousView === 'terminal') {
      await expect(orcaPage.locator('.xterm').first()).toBeVisible({ timeout: 5_000 })
    }
  })
})
