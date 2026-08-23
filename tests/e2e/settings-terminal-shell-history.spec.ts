import type { Locator, Page } from '@stablyai/playwright-test'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

function getSettingsSearch(page: Page): Locator {
  return page.locator('.settings-view-shell aside').getByRole('textbox')
}

async function openSettings(page: Page): Promise<void> {
  await page.evaluate(() => window.__store!.getState().openSettingsPage())
  await expect(getSettingsSearch(page)).toBeVisible({ timeout: 10_000 })

  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLaterButton.isVisible().catch(() => false)) {
    await maybeLaterButton.click()
  }
}

async function getSettings(page: Page): Promise<GlobalSettings> {
  return page.evaluate(() => window.api.settings.get())
}

test('finds and persists the shell history opt-out', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  // Why: English locators must not depend on the host's system locale.
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
  })
  await openSettings(orcaPage)
  await getSettingsSearch(orcaPage).fill('HISTFILE')

  const toggle = orcaPage.getByRole('switch', {
    name: 'Scope shell history to each workspace'
  })
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(orcaPage.getByText('Changes apply to new terminal sessions.')).toBeVisible()

  await toggle.click()

  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect
    .poll(async () => (await getSettings(orcaPage)).terminalScopeHistoryByWorktree, {
      timeout: 5_000,
      message: 'shell history opt-out did not persist'
    })
    .toBe(false)
})
