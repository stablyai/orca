import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })
test('Claude rich output is opt-in and persists independently of inline images', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({ uiLanguage: 'en', theme: 'light' })
    state.openSettingsTarget({ pane: 'terminal', repoId: null })
    state.openSettingsPage()
  })
  const toggle = orcaPage.getByRole('switch', { name: 'Claude Rich Output', exact: true })
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle
    .locator('..')
    .locator('..')
    .screenshot({ path: testInfo.outputPath('rich-output-off.png'), animations: 'disabled' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect
    .poll(async () => (await orcaPage.evaluate(() => window.api.settings.get())).claudeRichOutput)
    .toBe(true)
  await toggle
    .locator('..')
    .locator('..')
    .screenshot({ path: testInfo.outputPath('rich-output-on.png'), animations: 'disabled' })
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'terminal', repoId: null })
    state.openSettingsPage()
  })
  await expect(toggle).toBeChecked()
  expect((await orcaPage.evaluate(() => window.api.settings.get())).claudeRichOutput).toBe(true)
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect
    .poll(async () => (await orcaPage.evaluate(() => window.api.settings.get())).claudeRichOutput)
    .toBe(false)
  expect((await orcaPage.evaluate(() => window.api.settings.get())).terminalInlineImages).toBe(true)
})

test('Claude rich output preserves disabled inline images through toggle and reload', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({ uiLanguage: 'en', theme: 'light', terminalInlineImages: false })
    state.openSettingsTarget({ pane: 'terminal', repoId: null })
    state.openSettingsPage()
  })
  const rich = orcaPage.getByRole('switch', { name: 'Claude Rich Output', exact: true })
  const images = orcaPage.getByRole('switch', { name: 'Inline Images', exact: true })
  await expect(images).not.toBeChecked()
  await rich.scrollIntoViewIfNeeded()
  await rich.click()
  await expect(rich).toBeChecked()
  await expect(images).not.toBeChecked()
  await orcaPage.screenshot({
    path: testInfo.outputPath('rich-output-on-inline-images-off.png'),
    animations: 'disabled'
  })
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'terminal', repoId: null })
    state.openSettingsPage()
  })
  await expect(rich).toBeChecked()
  await expect(images).not.toBeChecked()
  await rich.click()
  await expect(rich).not.toBeChecked()
  await expect(images).not.toBeChecked()
})
