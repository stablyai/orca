import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('switches the desktop settings interface to Traditional Chinese', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900)
  })
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.updateSettings({ uiLanguage: 'en' })
    state.openSettingsTarget({ pane: 'appearance', repoId: null })
    state.openSettingsPage()
  })

  const language = orcaPage.getByRole('combobox', { name: 'Language' })
  await expect(language).toBeVisible()
  await testInfo.attach('before-language-switch', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  if (process.env.ORCA_ZH_TW_PROOF_DIR) {
    await orcaPage.screenshot({ path: path.join(process.env.ORCA_ZH_TW_PROOF_DIR, 'before.png') })
  }

  await orcaPage.evaluate(() => {
    window.__store!.getState().updateSettings({ uiLanguage: 'zh-TW' })
  })

  await expect(orcaPage.getByRole('combobox', { name: '語言' })).toContainText('繁體中文')
  await expect(orcaPage.getByText('外觀', { exact: true }).first()).toBeVisible()
  await testInfo.attach('after-language-switch', {
    body: await orcaPage.screenshot(),
    contentType: 'image/png'
  })
  if (process.env.ORCA_ZH_TW_PROOF_DIR) {
    await orcaPage.screenshot({ path: path.join(process.env.ORCA_ZH_TW_PROOF_DIR, 'after.png') })
  }
})
