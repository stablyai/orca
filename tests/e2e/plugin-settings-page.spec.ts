/**
 * Invariant: a plugin settings page appears in Settings only after the user
 * consents to the settingsPage capability, renders in the sandboxed panel
 * shell, and reads and writes the plugin's own settings without a worker.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

const PLUGIN_KEY = 'orca-samples.greeting-settings'
const OPEN_PAGE = 'Open Greeting settings for Greeting Settings'

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // CDP capture of the hidden test window; never brings it to the foreground.
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('renders a consented plugin settings page that saves the plugin settings', async ({
  orcaPage
}, testInfo) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-settings-page-plugin-e2e-'))
  const pluginRoot = join(tempRoot, 'greeting-settings')
  await cp(join(process.cwd(), 'examples', 'plugins', 'greeting-settings'), pluginRoot, {
    recursive: true
  })

  try {
    const pending = await orcaPage.evaluate(async (sourcePath) => {
      const settings = await window.api.settings.set({
        pluginSystemEnabled: true,
        devPluginPaths: [sourcePath]
      })
      window.__store?.setState({ settings })
      const plugins = await window.api.plugins.refresh()
      return plugins.find((entry) => entry.pluginKey === 'orca-samples.greeting-settings') ?? null
    }, pluginRoot)
    expect(pending).toMatchObject({
      status: 'pending',
      settingsPages: [{ id: 'preferences', title: 'Greeting settings' }]
    })

    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      state.openSettingsTarget({ pane: 'plugins', repoId: null })
      state.openSettingsPage()
    })
    await orcaPage.getByRole('tab', { name: /^Installed/ }).click()
    const row = orcaPage.locator(`[data-plugin-key="${PLUGIN_KEY}"]`)
    // Nothing from the plugin is reachable before consent.
    await expect(row.getByRole('button', { name: OPEN_PAGE })).toHaveCount(0)
    await row.getByRole('button', { name: 'Review & enable' }).click()
    const consent = orcaPage.getByRole('dialog', { name: 'Review permissions' })
    await expect(consent).toContainText(
      "Show the plugin's own settings page inside Orca's Settings"
    )
    await expect(consent).toContainText("Read and change the plugin's own settings")
    await screenshot(orcaPage, testInfo, 'consent-settings-page')
    await consent.getByRole('button', { name: 'Enable plugin' }).click()
    await expect(consent).toBeHidden()

    await screenshot(orcaPage, testInfo, 'plugin-card-settings-button')
    await row.getByRole('button', { name: OPEN_PAGE }).click()
    const dialog = orcaPage.getByRole('dialog', { name: 'Greeting settings' })
    await expect(dialog).toContainText('Provided by the Greeting Settings plugin')
    const frame = orcaPage.frameLocator('iframe[title="Greeting settings"]')
    await expect(frame.locator('#status')).toHaveText('Loaded', { timeout: 15_000 })
    await expect(frame.locator('#greeting')).toHaveValue('Hello')
    await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      'content',
      /connect-src 'none'/
    )

    await frame.locator('#greeting').fill('Ahoy')
    await frame.getByRole('button', { name: 'Save' }).click()
    await expect(frame.locator('#status')).toHaveText('Saved')
    await screenshot(orcaPage, testInfo, 'settings-page-saved')

    // Reopening loads the value back through settings.get. Focus is inside the
    // frame, so close through the dialog button rather than Escape.
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()
    await row.getByRole('button', { name: OPEN_PAGE }).click()
    await expect(frame.locator('#status')).toHaveText('Loaded', { timeout: 15_000 })
    await expect(frame.locator('#greeting')).toHaveValue('Ahoy')
    await dialog.getByRole('button', { name: 'Close' }).click()
    await expect(dialog).toBeHidden()

    // Disabling the plugin takes the page away.
    await row.getByRole('switch', { name: 'Disable Greeting Settings' }).click()
    await expect(row.getByRole('button', { name: OPEN_PAGE })).toHaveCount(0)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
