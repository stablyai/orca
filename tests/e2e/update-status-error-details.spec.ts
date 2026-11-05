import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const CHECK_ERROR = 'E2E update check failed: connection refused'

test.use({ seedTestRepo: false })

for (const theme of ['dark', 'light'] as const) {
  test(`automatic update failure opens details from the status bar (${theme})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 800 })
    await orcaPage.evaluate(async (theme) => {
      const state = window.__store!.getState()
      await state.updateSettingsOrThrow({ theme })
      state.setUpdateStatus({ state: 'checking', userInitiated: false })
    }, theme)
    await expect(orcaPage.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /\blight\b/)
    await orcaPage.evaluate((message) => {
      window.__store!.getState().setUpdateStatus({
        state: 'error',
        message,
        userInitiated: false
      })
    }, CHECK_ERROR)

    const statusButton = orcaPage.getByRole('button', {
      name: 'Update failed. Click to expand.',
      exact: true
    })
    const card = orcaPage.getByRole('complementary', { name: 'Update error', exact: true })
    await expect(statusButton).toBeVisible()
    await expect(card).toBeHidden()

    await statusButton.click()
    // Capture before the assertion so the broken build provides the same visual evidence.
    const statusClickScreenshot = testInfo.outputPath(
      `update-error-after-status-click-${theme}.png`
    )
    await orcaPage.screenshot({ path: statusClickScreenshot, animations: 'disabled' })
    await testInfo.attach(`update-error-after-status-click-${theme}`, {
      path: statusClickScreenshot,
      contentType: 'image/png'
    })
    await expect(card).toBeVisible()
    await expect(statusButton).toHaveAttribute('aria-expanded', 'true')
    await expect(card.getByRole('heading', { name: 'Update Check Failed' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Re-check', exact: true })).toBeVisible()

    await card.getByRole('button', { name: 'Show details', exact: true }).click()
    await expect(card.getByText(CHECK_ERROR, { exact: true })).toBeVisible()
    const detailsScreenshot = testInfo.outputPath(`update-error-expanded-details-${theme}.png`)
    await orcaPage.screenshot({ path: detailsScreenshot, animations: 'disabled' })
    await testInfo.attach(`update-error-expanded-details-${theme}`, {
      path: detailsScreenshot,
      contentType: 'image/png'
    })

    await card.getByRole('button', { name: 'Minimize to status bar', exact: true }).click()
    await expect(card).toBeHidden()
    await expect(statusButton).toHaveAttribute('aria-expanded', 'false')
    await statusButton.click()
    await expect(card).toBeVisible()
    await expect(statusButton).toHaveAttribute('aria-expanded', 'true')
  })
}
