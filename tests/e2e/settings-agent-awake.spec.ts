import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { GlobalSettings } from '../../src/shared/types'

async function getSettings(
  page: Parameters<typeof waitForSessionReady>[0]
): Promise<GlobalSettings> {
  return page.evaluate(() => window.api.settings.get())
}

async function openSettings(page: Parameters<typeof waitForSessionReady>[0]): Promise<void> {
  await page.evaluate(() => {
    window.__store!.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
}

test.describe('Agent awake setting', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('can be toggled from Agents settings and persists through IPC', async ({ orcaPage }) => {
    await openSettings(orcaPage)
    await orcaPage.getByPlaceholder('Search settings').fill('awake')

    await expect(
      orcaPage.getByText('Keep computer awake when Orca sees agents running').first()
    ).toBeVisible()

    const keepAwakeSwitch = orcaPage.getByRole('switch', {
      name: 'Keep computer awake when Orca sees agents running'
    })

    await expect(keepAwakeSwitch).toHaveAttribute('aria-checked', 'false')
    await keepAwakeSwitch.click()
    await expect(keepAwakeSwitch).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(async () => (await getSettings(orcaPage)).keepComputerAwakeWhileAgentsRun, {
        timeout: 5_000,
        message: 'keep-awake setting did not persist after enabling'
      })
      .toBe(true)

    await keepAwakeSwitch.click()
    await expect(keepAwakeSwitch).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(async () => (await getSettings(orcaPage)).keepComputerAwakeWhileAgentsRun, {
        timeout: 5_000,
        message: 'keep-awake setting did not persist after disabling'
      })
      .toBe(false)
  })
})
