import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('desktop startup setting is visible and reflects native capability', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1200, height: 760 })

  const nativeState = await orcaPage.evaluate(async () => window.api.settings.getAppStartup())
  expect(nativeState).toEqual({ supported: true, canModify: false, openAtLogin: false })

  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: 'general', repoId: null })
    state?.setSettingsSearchQuery('startup')
    state?.openSettingsPage()
  })

  const section = orcaPage.getByTestId('general-startup-settings')
  await expect(section).toBeVisible()
  await expect(section.getByRole('switch')).toBeDisabled()
  await section.screenshot({ path: testInfo.outputPath('settings-app-startup.png') })
})
