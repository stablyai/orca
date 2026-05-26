import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { GlobalSettings } from '../../src/shared/types'

async function getSettings(
  page: Parameters<typeof waitForSessionReady>[0]
): Promise<GlobalSettings> {
  return page.evaluate(() => window.api.settings.get())
}

async function openNotificationSettings(
  page: Parameters<typeof waitForSessionReady>[0]
): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'notifications', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  const featureTipDialog = page.getByRole('dialog', { name: 'Voice Dictation is here' })
  if (await featureTipDialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Maybe Later' }).click()
  }
  await expect(
    page
      .locator('[data-settings-section="notifications"]')
      .getByRole('heading', { name: 'Notifications', exact: true })
  ).toBeInViewport({ timeout: 10_000 })
}

test.describe('Notification settings', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('can be toggled from settings and disables child controls', async ({ orcaPage }) => {
    await openNotificationSettings(orcaPage)

    const notificationsSection = orcaPage.locator('[data-settings-section="notifications"]')
    const enableNotificationsSwitch = notificationsSection.getByRole('switch', {
      name: 'Enable Notifications'
    })
    const agentTaskCompleteSwitch = notificationsSection.getByRole('switch', {
      name: 'Agent Task Complete'
    })
    const terminalBellSwitch = notificationsSection.getByRole('switch', { name: 'Terminal Bell' })
    const suppressWhileFocusedSwitch = notificationsSection.getByRole('switch', {
      name: 'Suppress While Focused'
    })
    const sendTestButton = notificationsSection.getByRole('button', {
      name: 'Send Test Notification'
    })

    await expect(enableNotificationsSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(agentTaskCompleteSwitch).toBeEnabled()
    await expect(terminalBellSwitch).toBeEnabled()
    await expect(suppressWhileFocusedSwitch).toBeEnabled()
    await expect(sendTestButton).toBeEnabled()

    await agentTaskCompleteSwitch.click()
    await expect(agentTaskCompleteSwitch).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(async () => (await getSettings(orcaPage)).notifications.agentTaskComplete, {
        timeout: 5_000,
        message: 'agent task-complete notification setting did not persist after disabling'
      })
      .toBe(false)

    await enableNotificationsSwitch.click()
    await expect(enableNotificationsSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(agentTaskCompleteSwitch).toBeDisabled()
    await expect(terminalBellSwitch).toBeDisabled()
    await expect(suppressWhileFocusedSwitch).toBeDisabled()
    await expect(sendTestButton).toBeDisabled()
    await expect
      .poll(async () => (await getSettings(orcaPage)).notifications.enabled, {
        timeout: 5_000,
        message: 'master notification setting did not persist after disabling'
      })
      .toBe(false)

    await enableNotificationsSwitch.click()
    await agentTaskCompleteSwitch.click()
    await expect
      .poll(async () => {
        const settings = await getSettings(orcaPage)
        return {
          enabled: settings.notifications.enabled,
          agentTaskComplete: settings.notifications.agentTaskComplete
        }
      })
      .toEqual({ enabled: true, agentTaskComplete: true })
  })
})
