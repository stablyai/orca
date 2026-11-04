import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.describe('default browser cookie clearing', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('remains available after clearing the default profile cookies', async ({
    orcaPage
  }, testInfo) => {
    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsTarget({ pane: 'browser', repoId: null })
      state.openSettingsPage()
    })

    const cookiesSection = orcaPage.locator('#browser-session-cookies')
    await expect(cookiesSection).toBeVisible({ timeout: 10_000 })

    const clearButton = cookiesSection.locator('[data-testid="clear-default-cookies-button"]')
    // Why: data-type="success" is locale-independent and specific to the success path.
    const successToasts = orcaPage.locator('[data-sonner-toast][data-type="success"]')

    await expect(clearButton).toBeEnabled()
    await orcaPage.screenshot({ path: testInfo.outputPath('before-clearing.png') })
    await clearButton.click()
    await expect(successToasts).toHaveCount(1, { timeout: 10_000 })
    await expect(clearButton).toBeEnabled()

    // Dismiss the first toast so the second request needs its own completion signal.
    await expect(successToasts).toHaveCount(0, { timeout: 10_000 })
    await clearButton.click()
    await expect(successToasts).toHaveCount(1, { timeout: 10_000 })
    await expect(clearButton).toBeEnabled()
    await orcaPage.screenshot({ path: testInfo.outputPath('after-repeated-clearing.png') })
  })
})
