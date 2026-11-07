import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { test, expect } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import { waitForSessionReady } from './helpers/store'

test.describe('Settings synonym search on the Shortcuts pane', () => {
  test('shortcut aliases keep rows visible and local search usable', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)

    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Pin English instead of following the host locale.
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.getState().openSettingsPage()
    })

    const searchInput = orcaPage.getByPlaceholder('Search settings')
    await expect(searchInput).toBeVisible()
    await expect(searchInput).toBeFocused()
    await searchInput.fill('hotkey')

    await expect(orcaPage.getByRole('button', { name: 'Shortcuts', exact: true })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await expect(orcaPage.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible()

    // Regression: a pane-title-only query used to blank the whole list (0/112).
    await expect(orcaPage.getByText('Go to File', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('No shortcuts match those filters.')).not.toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('hotkey-shortcuts-pane.png') })

    // Keep pane search working with a global query; the old empty base list broke their intersection.
    const localSearch = orcaPage.getByPlaceholder('Search command or keys')
    await localSearch.fill('go to')
    await expect(orcaPage.getByText('Go to File', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Force Reload', { exact: true })).not.toBeVisible()

    await localSearch.clear()
    await searchInput.fill('keybinding')
    await expect(orcaPage.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Go to File', { exact: true })).toBeVisible()

    await searchInput.fill('worktree')
    await expect(orcaPage.getByText('Create worktree', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Go to File', { exact: true })).not.toBeVisible()
  })

  test('a pane alias retains a real plugin shortcut row', async ({ orcaPage }) => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-settings-shortcut-search-plugin-'))

    try {
      await writeFile(
        join(pluginRoot, 'orca-plugin.json'),
        JSON.stringify({
          manifestVersion: 2,
          execution: 'declarative',
          id: 'shortcut-search',
          publisher: 'samples',
          name: 'Shortcut Search Plugin',
          version: '1.0.0',
          engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
          contributes: {
            commands: [{ id: 'tasks.open', title: 'Open Tasks', action: 'view.tasks' }],
            keybindings: [{ command: 'tasks.open', key: 'Mod+Alt+Shift+Y' }]
          }
        })
      )
      await enableDevPlugins(orcaPage, [pluginRoot])
      await waitForSessionReady(orcaPage)

      const setUiLanguage = async (uiLanguage: 'en' | 'ko') =>
        orcaPage.evaluate(async (language) => {
          const store = window.__store
          if (!store) {
            throw new Error('window.__store is not available')
          }
          await store.getState().updateSettings({ uiLanguage: language })
          store.getState().openSettingsPage()
        }, uiLanguage)
      await setUiLanguage('en')

      const searchInput = orcaPage.getByPlaceholder('Search settings')
      await expect(searchInput).toBeVisible()
      await searchInput.fill('hotkey')
      await expect(orcaPage.getByRole('heading', { name: 'Shortcuts', exact: true })).toBeVisible()
      const pluginShortcut = orcaPage.getByText('Open Tasks — Shortcut Search Plugin', {
        exact: true
      })
      await expect(pluginShortcut).toBeVisible()

      await searchInput.fill('keybinding')
      await expect(pluginShortcut).toBeVisible()

      await orcaPage.getByPlaceholder('Search command or keys').fill('Open Tasks')
      await expect(pluginShortcut).toBeVisible()
      await expect(orcaPage.getByText('Force Reload', { exact: true })).not.toBeVisible()

      await setUiLanguage('ko')
      const localizedSettingsSearch = orcaPage.getByPlaceholder('설정 검색')
      const localizedShortcutSearch = orcaPage.getByPlaceholder('명령 또는 키 검색')
      await localizedSettingsSearch.fill('hotkey')
      await expect(localizedShortcutSearch).toBeVisible()
      await expect(pluginShortcut).toBeVisible()

      await localizedShortcutSearch.fill('Open Tasks')
      await expect(pluginShortcut).toBeVisible()
      await expect(orcaPage.getByText('Force Reload', { exact: true })).not.toBeVisible()
      await setUiLanguage('en')
    } finally {
      await orcaPage
        .evaluate(async () => {
          await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
        })
        .catch(() => undefined)
      await disablePluginSystem(orcaPage).catch(() => undefined)
      await rm(pluginRoot, { recursive: true, force: true })
    }
  })
})
