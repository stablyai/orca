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

async function writeThemePlugin(root: string, themeCount = 1): Promise<void> {
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
        themes: Array.from({ length: themeCount }, (_, index) => ({
          id: index === 0 ? 'dusk' : `dusk-${index}`,
          title: index === 0 ? 'Smoke Dusk' : `Smoke Dusk ${index + 1}`,
          path: 'app.json'
        })),
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

test('keeps the theme picker footer visible while scrolling in a short window', async ({
  orcaPage
}) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-theme-picker-'))
  try {
    await writeThemePlugin(pluginRoot, 18)
    await enableDevPlugins(orcaPage, [pluginRoot])
    const viewportHeight = 600
    await orcaPage.setViewportSize({ width: 1024, height: viewportHeight })
    await openAppearance(orcaPage)

    const trigger = orcaPage.getByRole('combobox', { name: 'Dark theme', exact: true })
    await trigger.scrollIntoViewIfNeeded()
    await trigger.evaluate((element) => {
      let parent = element.parentElement
      while (
        parent &&
        !(
          parent.scrollHeight > parent.clientHeight &&
          /(auto|scroll)/.test(getComputedStyle(parent).overflowY)
        )
      ) {
        parent = parent.parentElement
      }
      if (!parent) {
        throw new Error('Settings scroll container not found')
      }
      parent.scrollTop += element.getBoundingClientRect().top - 300
    })
    await trigger.click()

    const popup = orcaPage.locator('[data-slot="popover-content"]')
    const list = popup.locator('[cmdk-list]')
    const search = popup.getByPlaceholder('Search themes…')
    const footer = popup.getByRole('button', { name: 'Browse themes' })
    await expect(popup.getByRole('option', { name: 'Smoke Dusk 18' })).toHaveCount(1)
    await expect
      .poll(() => list.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(0)
    const controlsFit = async (): Promise<boolean> => {
      const popupBox = await popup.boundingBox()
      const searchBox = await search.boundingBox()
      const footerBox = await footer.boundingBox()
      return (
        popupBox !== null &&
        searchBox !== null &&
        footerBox !== null &&
        footerBox.y >= popupBox.y &&
        footerBox.y + footerBox.height <= popupBox.y + popupBox.height &&
        searchBox.y >= 0 &&
        searchBox.y + searchBox.height <= viewportHeight &&
        footerBox.y >= 0 &&
        footerBox.y + footerBox.height <= viewportHeight
      )
    }
    await expect.poll(controlsFit).toBe(true)
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await controlsFit()).toBe(true)
    await search.focus()
    await orcaPage.keyboard.press('Tab')
    await expect(footer).toBeFocused()
  } finally {
    await disablePluginSystem(orcaPage)
    await rm(pluginRoot, { recursive: true, force: true })
  }
})

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
