import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { expectTerminalAccessibilityText } from './helpers/terminal-accessibility-tree'

test('Accounts prepares each ZCode sign-in command and closes its terminal', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-zcode' })
    state?.openSettingsPage()
  })
  const section = orcaPage.locator('#accounts-zcode')
  await expect(section).toBeVisible({ timeout: 30_000 })
  await section.screenshot({ path: testInfo.outputPath('01-setup-buttons.png') })
  for (const [label, command] of [
    ['Z.AI browser sign-in', 'zcode login zai --no-browser'],
    ['BigModel browser sign-in', 'zcode login bigmodel --no-browser'],
    ['ZCode API-key setup', 'zcode']
  ] as const) {
    await section.getByRole('button', { name: label, exact: true }).click()
    const close = section.getByRole('button', { name: 'Close setup terminal', exact: true })
    await expect(close).toBeVisible({ timeout: 15_000 })
    const tabId = await section
      .locator('[data-terminal-tab-id]')
      .first()
      .getAttribute('data-terminal-tab-id')
    if (!tabId) {
      throw new Error('Setup terminal did not mount')
    }
    await expectTerminalAccessibilityText(orcaPage, tabId, command)
    await expect(section.getByRole('button', { name: label, exact: true })).toBeDisabled()
    await section.screenshot({ path: testInfo.outputPath(`${label}.png`) })
    await close.click()
    await expect(close).toHaveCount(0)
    await expect(section.locator('[data-terminal-tab-id]')).toHaveCount(0)
    await expect(section.getByRole('button', { name: label, exact: true })).toBeEnabled()
  }
})
