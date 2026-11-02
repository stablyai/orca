/**
 * Invariant: a plugin app theme fills the Dark theme slot and an icon theme applies live from
 * Settings, and disabling the plugin restores Orca's colors and the built-in icons.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  disablePluginSystem,
  editorTokenColor,
  enableDevPlugins,
  openRepoFile
} from './helpers/plugin-smoke'

const CODE_FILE = 'plugin-theme-smoke.ts'
const THEME_KEYWORD = 'rgb(255, 122, 217)'

async function writeThemePlugin(root: string): Promise<void> {
  await mkdir(join(root, 'icons'), { recursive: true })
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'theme-smoke',
      publisher: 'samples',
      name: 'Theme Smoke',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        themes: [{ id: 'dusk', title: 'Smoke Dusk', path: 'app.json' }],
        iconThemes: [{ id: 'blocks', title: 'Smoke Blocks', path: 'icons.json' }]
      }
    })
  )
  await writeFile(
    join(root, 'app.json'),
    JSON.stringify({
      base: 'dark',
      // Why --sidebar: the left sidebar is set off by its surface step, not a border line.
      tokens: { '--background': '#1b1430', '--foreground': '#e8e0ff', '--sidebar': '#271d45' },
      tokenColors: [{ scope: 'keyword', settings: { foreground: '#ff7ad9' } }]
    })
  )
  await writeFile(
    join(root, 'icons.json'),
    JSON.stringify({
      schemaVersion: 1,
      icons: { file: 'icons/file.svg', folder: 'icons/file.svg' }
    })
  )
  await writeFile(
    join(root, 'icons', 'file.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#22c55e"/></svg>'
  )
}

async function openAppearance(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: 'appearance', repoId: null })
    state?.openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="appearance"]')).toBeVisible()
}

async function choose(page: Page, select: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: select, exact: true }).click()
  await page.getByRole('option', { name: option }).click()
}

const background = (page: Page): Promise<string> =>
  page.evaluate(() => document.documentElement.style.getPropertyValue('--background'))

test('plugin themes apply live and fall back when the plugin goes away', async ({
  orcaPage,
  seededRepoPath
}) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-theme-smoke-'))
  const themeBefore = await orcaPage.evaluate(() => window.__store?.getState().settings?.theme)
  try {
    await writeThemePlugin(pluginRoot)
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openAppearance(orcaPage)

    await orcaPage
      .getByRole('radiogroup', { name: 'Theme', exact: true })
      .getByRole('radio', { name: 'Dark', exact: true })
      .click()
    await choose(orcaPage, 'Dark theme', 'Smoke Dusk')
    await expect.poll(() => background(orcaPage)).toBe('#1b1430')
    // The left sidebar's surface, its only edge against the canvas, follows the theme.
    await expect
      .poll(() =>
        orcaPage.evaluate(() =>
          document.documentElement.style.getPropertyValue('--worktree-sidebar')
        )
      )
      .toBe('#271d45')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().settings?.pluginAppThemeDark))
      .toBe('plugin:samples.theme-smoke/dusk')

    // The theme's tokenColors color code in the editor.
    await writeFile(join(seededRepoPath, CODE_FILE), 'export const answer = 42\n')
    await orcaPage.evaluate(() => window.__store?.getState().closeSettingsPage())
    await openRepoFile(orcaPage, seededRepoPath, CODE_FILE)
    await expect
      .poll(() => editorTokenColor(orcaPage, 'export'), { timeout: 15_000 })
      .toBe(THEME_KEYWORD)
    await openAppearance(orcaPage)

    await choose(orcaPage, 'Icon theme', 'Smoke Blocks')
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.closeSettingsPage()
      state?.showRightSidebarFiles()
      state?.setRightSidebarOpen(true)
    })
    await expect.poll(() => orcaPage.locator('[data-plugin-icon]').count()).toBeGreaterThan(0)

    await disablePluginSystem(orcaPage)
    await expect.poll(() => background(orcaPage)).toBe('')
    await expect.poll(() => orcaPage.locator('[data-plugin-icon]').count()).toBe(0)
    await openRepoFile(orcaPage, seededRepoPath, CODE_FILE)
    await expect
      .poll(() => editorTokenColor(orcaPage, 'export'), { timeout: 15_000 })
      .not.toBe(THEME_KEYWORD)
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await orcaPage.evaluate(
      (theme) =>
        window.api.settings.set({
          theme: theme ?? 'system',
          pluginAppThemeDark: null,
          pluginIconTheme: null
        }),
      themeBefore
    )
    await rm(join(seededRepoPath, CODE_FILE), { force: true })
    await rm(pluginRoot, { recursive: true, force: true })
  }
})
