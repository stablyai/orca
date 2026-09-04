import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Why: the previous Polytoken integration attempt crashed the Settings page in a
// packaged build with a renderer TypeError. This spec renders the page with the
// agent registered and fails on any uncaught renderer error.
async function openSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store!.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
}

async function dismissTransientAnnouncement(page: Page): Promise<void> {
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  const visible = await maybeLaterButton.isVisible({ timeout: 1_000 }).catch(() => false)
  if (visible) {
    await maybeLaterButton.click()
  }
}

test('renders the Polytoken agent row in Settings without renderer errors', async ({
  orcaPage
}) => {
  const rendererErrors: string[] = []
  orcaPage.on('pageerror', (error) => {
    rendererErrors.push(error.message)
  })

  await waitForSessionReady(orcaPage)
  await openSettings(orcaPage)
  await dismissTransientAnnouncement(orcaPage)
  await orcaPage.getByPlaceholder('Search settings').fill('Polytoken')
  await orcaPage.getByRole('button', { name: 'Agents' }).click()

  await expect(orcaPage.getByText('Polytoken', { exact: true }).first()).toBeVisible({
    timeout: 10_000
  })
  await expect(orcaPage.getByText('Something went wrong')).toHaveCount(0)
  expect(rendererErrors).toEqual([])
})
