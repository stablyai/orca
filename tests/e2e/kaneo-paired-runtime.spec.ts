import { test, expect } from './helpers/orca-app'
import { KANEO_TASK, installKaneoApiFixture } from './helpers/kaneo-api-fixture'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { waitForSessionReady } from './helpers/store'

test('Kaneo connection and Smart lookup belong to the selected paired runtime', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await installKaneoApiFixture(electronApp)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'Kaneo test host')
  try {
    await client.page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'integrations', repoId: null })
      state?.openSettingsPage()
    })
    const card = client.page.locator('[data-settings-section="kaneo-integration"]')
    await card.getByRole('button', { name: 'Connect Kaneo', exact: true }).click()
    await card.getByLabel('Instance URL', { exact: true }).fill(KANEO_TASK.siteUrl)
    await card.getByLabel('API key', { exact: true }).fill('fixture-api-key')
    await expect(card).toContainText('Credentials are stored on the selected remote runtime')
    await card.getByRole('button', { name: 'Save connection', exact: true }).click()
    await expect(card.getByText('Connected', { exact: true })).toBeVisible()
    expect(await orcaPage.evaluate(() => window.api.kaneo.status())).toMatchObject({
      connected: true
    })
    expect(await client.page.evaluate(() => window.api.kaneo.status())).toMatchObject({
      connected: false
    })
    await testInfo.attach('kaneo-paired-settings.png', {
      body: await client.page.screenshot(),
      contentType: 'image/png'
    })
    await client.page.evaluate(() => window.__store?.getState().closeSettingsPage())
    await client.page.getByRole('button', { name: 'New workspace', exact: true }).click()
    const dialog = client.page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    const input = dialog.locator('[data-workspace-name-input="true"]')
    await input.fill(KANEO_TASK.url)
    await expect(client.page.getByRole('status').filter({ hasText: 'rate limiting' })).toBeVisible()
    await client.page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(
      client.page.getByRole('option').filter({ hasText: KANEO_TASK.title })
    ).toBeVisible()
    await testInfo.attach('kaneo-paired-resolved.png', {
      body: await client.page.screenshot(),
      contentType: 'image/png'
    })
    await input.press('Enter')
    await expect(dialog.getByText(`#42 ${KANEO_TASK.title}`, { exact: true })).toBeVisible()
    expect(await client.page.evaluate(() => window.api.kaneo.status())).toMatchObject({
      connected: false
    })
    expect(
      await client.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
  } finally {
    await client.dispose()
  }
})
