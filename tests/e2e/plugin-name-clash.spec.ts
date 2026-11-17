/**
 * Invariant: two plugins that share a name, and themes that share a name, are told apart by the
 * Orca-derived publisher in the theme picker and the plugin list.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'

async function writeCatppuccinPlugin(root: string, publisher: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'catppuccin',
      publisher,
      name: 'Catppuccin for Orca',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { themes: [{ id: 'mocha', title: 'Catppuccin Mocha', path: 'app.json' }] }
    })
  )
  await writeFile(
    join(root, 'app.json'),
    JSON.stringify({
      base: 'dark',
      tokens: { '--background': '#1e1e2e', '--foreground': '#cdd6f4' }
    })
  )
}

async function openSettingsPane(page: Page, pane: 'appearance' | 'plugins'): Promise<void> {
  await page.evaluate((target) => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: target, repoId: null })
    state?.openSettingsPage()
  }, pane)
  await expect(page.locator(`[data-settings-section="${pane}"]`)).toBeVisible()
}

test('plugins and themes sharing a name show their publishers', async ({ orcaPage }, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-name-clash-'))
  const proofDir = process.env.ORCA_NAME_CLASH_PROOF_DIR
  try {
    await writeCatppuccinPlugin(join(root, 'acme'), 'acme')
    await writeCatppuccinPlugin(join(root, 'vale-c'), 'vale-c')
    await enableDevPlugins(orcaPage, [join(root, 'acme'), join(root, 'vale-c')])

    await openSettingsPane(orcaPage, 'appearance')
    await orcaPage.getByRole('combobox', { name: 'Dark theme', exact: true }).click()
    const options = orcaPage.getByRole('option', { name: /^Catppuccin Mocha/ })
    await expect(options).toHaveCount(2)
    await orcaPage.screenshot({
      path: join(proofDir ?? testInfo.outputPath(), 'theme-picker.png')
    })
    await expect(orcaPage.getByRole('option', { name: 'Catppuccin Mocha (acme)' })).toBeVisible()
    await expect(orcaPage.getByRole('option', { name: 'Catppuccin Mocha (vale-c)' })).toBeVisible()
    await orcaPage.keyboard.press('Escape')

    await openSettingsPane(orcaPage, 'plugins')
    const section = orcaPage.locator('[data-settings-section="plugins"]')
    await expect(section.getByText(/^Catppuccin for Orca/).first()).toBeVisible()
    await orcaPage.screenshot({
      path: join(proofDir ?? testInfo.outputPath(), 'plugin-list.png')
    })
    await expect(section.getByText('Catppuccin for Orca (acme)', { exact: true })).toBeVisible()
    await expect(section.getByText('Catppuccin for Orca (vale-c)', { exact: true })).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
