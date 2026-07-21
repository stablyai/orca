import { expect, test } from './helpers/orca-app'
import {
  getActiveTabId,
  waitForActiveWorktree,
  waitForSessionReady,
  ensureTerminalVisible
} from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'

const SORTABLE_TAB = '[data-testid="sortable-tab"]'

test.describe('detached terminal tabs', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForActivePanePtyId(orcaPage)
  })

  test('opens, reuses, and closes a detached terminal window without closing the origin tab', async ({
    electronApp,
    orcaPage
  }) => {
    const activeTabId = await getActiveTabId(orcaPage)
    const activeTab = orcaPage.locator(`${SORTABLE_TAB}[data-tab-id="${activeTabId}"]`).first()
    await expect(activeTab).toBeVisible()

    await activeTab.click({ button: 'right' })
    const firstWindowPromise = electronApp.waitForEvent('window')
    await orcaPage.getByRole('menuitem', { name: 'Open in New Window', exact: true }).click()
    const detachedWindow = await firstWindowPromise
    await detachedWindow.waitForLoadState('domcontentloaded')
    await expect(
      detachedWindow.getByRole('textbox', { name: 'Terminal input' }).first()
    ).toBeVisible({ timeout: 30_000 })

    await activeTab.click({ button: 'right' })
    const unexpectedWindowPromise = electronApp
      .waitForEvent('window', { timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
    await orcaPage.getByRole('menuitem', { name: 'Open in New Window', exact: true }).click()
    await expect.poll(async () => electronApp.windows().length, { timeout: 5_000 }).toBe(2)
    expect(await unexpectedWindowPromise).toBe(false)

    await detachedWindow.close()
    await expect(activeTab).toBeVisible({ timeout: 10_000 })
    await expect.poll(async () => electronApp.windows().length, { timeout: 5_000 }).toBe(1)
  })
})
