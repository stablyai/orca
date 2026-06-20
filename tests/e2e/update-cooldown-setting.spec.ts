import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

async function openSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store!.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
}

test.describe('Update cooldown setting', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('renders the cooldown control and persists the value', async ({ orcaPage }) => {
    await openSettings(orcaPage)

    const maybeLater = orcaPage.getByRole('button', { name: 'Maybe Later' })
    if (await maybeLater.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await maybeLater.click()
    }

    await orcaPage.getByPlaceholder('Search settings').fill('cooldown')
    await expect(orcaPage.getByText('Update cooldown').first()).toBeVisible()

    const input = orcaPage.getByRole('spinbutton').first()
    await expect(input).toBeVisible()
    await input.click()
    await input.fill('3')
    await input.press('Enter')

    // Why: the renderer setter writes through window.api.ui.set → store.updateUI,
    // which is the same persisted UI state the main-process cooldown reads.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => window.api.ui.get().then((ui) => ui.updateCooldownDays)),
        { timeout: 5_000, message: 'updateCooldownDays did not persist' }
      )
      .toBe(3)
  })
})
