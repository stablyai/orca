import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import type { GlobalSettings } from '../../src/shared/global-settings-types'

async function getSettings(page: Page): Promise<GlobalSettings> {
  return page.evaluate(() => window.api.settings.get())
}

test('ASCII-only branch names toggle renders in Git settings and persists', async ({
  orcaPage: page
}) => {
  await page.evaluate(() => {
    window.__store!.getState().openSettingsPage()
  })
  const search = page.getByPlaceholder('Search settings')
  await expect(search).toBeVisible({ timeout: 20_000 })

  const maybeLater = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLater.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLater.click()
  }

  await search.fill('ASCII-only branch names')
  const toggle = page.getByRole('switch', { name: 'ASCII-only branch names' })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  await expect(toggle).toHaveAttribute('data-state', 'unchecked')

  await toggle.click()
  await expect(toggle).toHaveAttribute('data-state', 'checked')

  await expect
    .poll(async () => (await getSettings(page)).asciiOnlyBranchNames, { timeout: 10_000 })
    .toBe(true)
})
