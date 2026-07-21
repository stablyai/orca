import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

async function openVoiceSettings(page: Parameters<typeof waitForSessionReady>[0]): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'voice', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  const featureTipDialog = page.getByRole('dialog', { name: 'Voice Dictation is here' })
  if (await featureTipDialog.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Maybe Later' }).click()
  }
  await expect(
    page.locator('[data-settings-section="voice"]').getByRole('heading', { name: 'Voice' })
  ).toBeInViewport({ timeout: 10_000 })
}

test.describe('Voice audio output settings', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('renders audio output controls and platform-safe ducking state', async ({ orcaPage }) => {
    await openVoiceSettings(orcaPage)

    const voiceSection = orcaPage.locator('[data-settings-section="voice"]')
    await expect(voiceSection.getByText('Pause playing media when dictation starts')).toBeVisible()
    await expect(voiceSection.getByText('System output while dictating')).toBeVisible()

    const capabilities = await orcaPage.evaluate(() => window.api.dictationOutput.getCapabilities())
    if (!capabilities.canDuckOutput) {
      await expect(voiceSection.getByText('Not supported on this platform yet.')).toBeVisible()
      return
    }

    await orcaPage.evaluate(async () => {
      const state = window.__store!.getState()
      await state.updateSettings({
        voice: {
          ...state.settings.voice,
          enabled: true,
          outputVolumeMode: 'duck',
          duckedVolumePercent: 20
        }
      })
    })

    await expect(voiceSection.getByText('Lower output to 20%')).toBeVisible()
  })
})
