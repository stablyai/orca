import type { Page } from '@stablyai/playwright-test'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import { expect, test } from './helpers/orca-app'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { waitForSessionReady } from './helpers/store'

// Why: a non-snowflake id makes every connect fail fast, so a Discord app running on this machine is never touched.
test.use({ orcaAppExtraEnv: { ORCA_DISCORD_CLIENT_ID: 'e2e-disabled' } })

async function openIntegrationsSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English strings; the host may run a non-English locale.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'integrations', repoId: null })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)
}

async function readEnabled(page: Page): Promise<boolean | undefined> {
  return page.evaluate(async () => {
    const settings: GlobalSettings = await window.api.settings.get()
    return settings.discordPresenceEnabled
  })
}

test.describe('Discord presence setting', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openIntegrationsSettings(orcaPage)
  })

  test('toggles from Integrations and reports when Discord is unreachable', async ({
    orcaPage
  }, testInfo) => {
    const card = orcaPage.locator('[data-settings-section="integrations-discord"]')
    await card.scrollIntoViewIfNeeded()
    const toggle = card.getByRole('switch', { name: 'Share activity on Discord' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect(card.getByText('Off', { exact: true })).toBeVisible()
    await card.screenshot({ path: testInfo.outputPath('discord-card-off.png') })

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => readEnabled(orcaPage), { timeout: 5_000 }).toBe(true)
    await expect(card.getByText('Discord not running')).toBeVisible({ timeout: 5_000 })
    await card.screenshot({ path: testInfo.outputPath('discord-card-unavailable.png') })

    await toggle.click()
    await expect.poll(() => readEnabled(orcaPage), { timeout: 5_000 }).toBe(false)
    await expect(card.getByText('Off', { exact: true })).toBeVisible()
  })

  test('is found by settings search', async ({ orcaPage }) => {
    await orcaPage.getByPlaceholder('Search settings').fill('rich presence')
    await expect(orcaPage.locator('[data-settings-section="integrations-discord"]')).toBeVisible()
  })
})
