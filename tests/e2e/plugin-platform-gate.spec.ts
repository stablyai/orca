/**
 * Invariant: a plugin whose manifest `platforms` exclude this computer is
 * listed as unavailable with a plain explanation, never asks for consent, and
 * cannot be enabled, while a matching plugin beside it stays reviewable.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'

async function writeDevPlugin(root: string, id: string, platforms: string[]): Promise<string> {
  const pluginRoot = join(root, id)
  await mkdir(pluginRoot, { recursive: true })
  await writeFile(join(pluginRoot, 'main.mjs'), 'export default function activate() {}\n')
  await writeFile(
    join(pluginRoot, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      publisher: 'orca-samples',
      name: id === 'elsewhere' ? 'Elsewhere Tool' : 'Here Tool',
      version: '1.0.0',
      description: 'Platform gate fixture.',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      platforms,
      main: 'main.mjs',
      contributes: { commands: [{ id: 'run', title: 'Run' }] },
      capabilities: []
    })
  )
  return pluginRoot
}

test('lists a plugin for another operating system as unavailable', async ({
  orcaPage
}, testInfo) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-platform-e2e-'))
  const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32'
  try {
    const elsewhere = await writeDevPlugin(tempRoot, 'elsewhere', [otherPlatform])
    const here = await writeDevPlugin(tempRoot, 'here', [process.platform])
    const listed = await orcaPage.evaluate(
      async (paths) => {
        const settings = await window.api.settings.set({
          pluginSystemEnabled: true,
          devPluginPaths: paths
        })
        window.__store?.setState({ settings })
        return window.api.plugins.refresh()
      },
      [elsewhere, here]
    )
    expect(listed.find((entry) => entry.pluginKey === 'orca-samples.elsewhere')).toMatchObject({
      status: 'invalid',
      name: 'Elsewhere Tool',
      unsupportedPlatform: { platforms: [otherPlatform] },
      commands: []
    })
    expect(listed.find((entry) => entry.pluginKey === 'orca-samples.here')).toMatchObject({
      status: 'pending'
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
    const row = orcaPage.locator('[data-plugin-key="orca-samples.elsewhere"]')
    await expect(row).toContainText('Unavailable')
    await expect(row).toContainText('It stays off on this computer.')
    await expect(row).not.toContainText('Invalid')
    await expect(row.getByRole('button', { name: 'Review & enable' })).toHaveCount(0)
    await expect(row.getByRole('switch')).toBeDisabled()
    await expect(
      orcaPage
        .locator('[data-plugin-key="orca-samples.here"]')
        .getByRole('button', { name: 'Review & enable' })
    ).toBeVisible()

    // CDP capture of the hidden test window; it never takes the foreground.
    const path = testInfo.outputPath('plugin-platform-unavailable.png')
    await row.locator('xpath=..').screenshot({ path })
    await testInfo.attach('plugin-platform-unavailable', { path, contentType: 'image/png' })
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
