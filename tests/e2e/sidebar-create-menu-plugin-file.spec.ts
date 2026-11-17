import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test } from './desktop/electron-fixtures/orca-app'
import { worktreeRow } from './workspaces/sidebar/worktree-row-locators'
import { disablePluginSystem, enableDevPlugins } from './plugins/plugin-smoke'
import { pluginGuest, ISOLATED_FRAMES_E2E } from './plugins/plugin-frame-guest'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'

test.use(ISOLATED_FRAMES_E2E)
const TEMPLATE = '{"type":"sketch","elements":[]}\n'

async function writeSketchPlugin(root: string): Promise<void> {
  await mkdir(join(root, 'editor'), { recursive: true })
  await mkdir(join(root, 'templates'), { recursive: true })
  await writeFile(join(root, 'editor', 'index.html'), '<textarea></textarea>')
  await writeFile(join(root, 'templates', 'empty.sketch'), TEMPLATE)
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'sketch-pad',
      publisher: 'samples',
      name: 'Sketch Pad',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      contributes: {
        customEditors: [
          { id: 'sketch', title: 'Sketch Pad', extensions: ['.sketch'], entry: 'editor/index.html' }
        ],
        newFiles: [
          {
            id: 'sketch',
            title: 'New sketch',
            extension: '.sketch',
            template: 'templates/empty.sketch'
          }
        ]
      }
    })
  )
}

test('sidebar static plugin creation waits for the file without seeding a terminal', async ({
  orcaPage,
  seededRepoPath
}) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-sidebar-new-file-'))
  const filePath = join(seededRepoPath, 'untitled.sketch')
  try {
    await writeSketchPlugin(pluginRoot)
    await enableDevPlugins(orcaPage, [pluginRoot])
    const worktreeId = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const id = state.activeWorktreeId!
      for (const tab of state.tabsByWorktree[id] ?? []) {
        state.closeTab(tab.id, { reason: 'user' })
      }
      const original = state.openNewPluginFileInActiveWorkspace
      window.__store!.setState({
        openNewPluginFileInActiveWorkspace: async (...args) => {
          await new Promise<void>((resolve) =>
            window.addEventListener('test-release-plugin-file', () => resolve(), { once: true })
          )
          await original(...args)
        }
      })
      return id
    })
    await worktreeRow(orcaPage, worktreeId)
      .getByRole('button', { name: 'New tab', exact: true })
      .click({ force: true })
    await orcaPage
      .getByRole('menu')
      .getByRole('button', { name: 'New sketch', exact: true })
      .click({ force: true })
    await expect(orcaPage.getByRole('menu')).toBeHidden()
    await orcaPage.evaluate(() => window.dispatchEvent(new Event('test-release-plugin-file')))
    await expect.poll(() => readFile(filePath, 'utf8').catch(() => null)).toBe(TEMPLATE)
    await expect(pluginGuest(orcaPage, 'Sketch Pad')).toBeVisible({ timeout: 15_000 })
    await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(0)
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(filePath, { force: true })
    await rm(pluginRoot, { recursive: true, force: true })
  }
})
