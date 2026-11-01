/**
 * Invariant: `orca plugin shot` captures exactly a plugin panel as Orca draws it, from the hidden
 * test window, without showing or focusing it: a components panel (Orca's own DOM) at the asked
 * width and theme, and an html panel whose isolated guest content is in the image.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { orcaCliResult } from './helpers/compiled-orca-cli'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import { ISOLATED_FRAMES_E2E } from './helpers/plugin-frame-guest'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.use(ISOLATED_FRAMES_E2E)

type Shot = {
  path: string
  panelId: string
  width: number
  height: number
  theme: 'light' | 'dark'
  themeApplied: boolean
  settled: boolean
  errors: string[]
}

type PngStats = { width: number; height: number; colors: number; redShare: number }

/** Decodes the PNG in Electron's main process: no image library in the test runner. */
function pngStats(app: ElectronApplication, path: string): Promise<PngStats> {
  return app.evaluate(({ nativeImage }, file) => {
    const image = nativeImage.createFromPath(file)
    const { width, height } = image.getSize()
    const bgra = image.toBitmap()
    const colors = new Set<number>()
    let red = 0
    for (let at = 0; at + 3 < bgra.length; at += 4) {
      const [b, g, r] = [bgra[at] ?? 0, bgra[at + 1] ?? 0, bgra[at + 2] ?? 0]
      colors.add((r << 16) | (g << 8) | b)
      if (r > 200 && g < 60 && b < 60) {
        red += 1
      }
    }
    return { width, height, colors: colors.size, redShare: red / Math.max(1, width * height) }
  }, path)
}

/** The window stays hidden and unfocused: a capture is renderer state plus capturePage only. */
function windowsShown(app: ElectronApplication): Promise<boolean[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.isVisible() || window.isFocused())
  )
}

async function devPluginKey(page: Page, name: string): Promise<string> {
  let key = ''
  await expect
    .poll(
      async () => {
        const list = await page.evaluate(() => window.api.plugins.list())
        key = list.find((plugin) => plugin.isDev && plugin.name === name)?.pluginKey ?? ''
        return key
      },
      { timeout: 15_000, message: `the ${name} dev plugin never listed` }
    )
    .not.toBe('')
  return key
}

async function devChangeCount(page: Page, pluginKey: string): Promise<number> {
  const list = await page.evaluate(() => window.api.plugins.list())
  return list.find((plugin) => plugin.pluginKey === pluginKey)?.devChangeCount ?? 0
}

test('plugin shot captures a components panel at the asked width and theme, hidden', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-shot-'))
  const pluginRoot = join(tempRoot, 'hello-tsx')
  try {
    await cp(join(process.cwd(), 'examples', 'plugins', 'hello-tsx'), pluginRoot, {
      recursive: true
    })
    await enableDevPlugins(orcaPage, [pluginRoot])
    const pluginKey = await devPluginKey(orcaPage, 'Hello TSX')
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const themeBefore = await orcaPage.evaluate(() => window.__store?.getState().settings?.theme)
    const widthBefore = await orcaPage.evaluate(() => window.__store?.getState().rightSidebarWidth)
    const shownBefore = await windowsShown(electronApp)

    const dark = await orcaCliResult<Shot>(userDataDir, [
      'plugin',
      'shot',
      pluginKey,
      '--width',
      '360',
      '--theme',
      'dark',
      '--out',
      join(tempRoot, 'dark.png')
    ])
    expect(dark).toMatchObject({ panelId: 'todos', width: 360, settled: true, errors: [] })
    expect(dark).toMatchObject({ theme: 'dark', themeApplied: true })
    const darkStats = await pngStats(electronApp, dark.path)
    expect(darkStats).toMatchObject({ width: 360, height: dark.height })
    expect(darkStats.height).toBeGreaterThan(200)
    // Text, inputs and buttons: far from a blank or single-color capture.
    expect(darkStats.colors).toBeGreaterThan(20)

    const light = await orcaCliResult<Shot>(userDataDir, [
      'plugin',
      'shot',
      pluginKey,
      '--theme',
      'light',
      '--out',
      join(tempRoot, 'light.png')
    ])
    expect(light).toMatchObject({ theme: 'light', themeApplied: true, settled: true })
    expect((await pngStats(electronApp, light.path)).colors).toBeGreaterThan(20)

    // Nothing the capture changed outlives it.
    expect(await orcaPage.evaluate(() => window.__store?.getState().settings?.theme)).toBe(
      themeBefore
    )
    expect(await orcaPage.evaluate(() => window.__store?.getState().rightSidebarWidth)).toBe(
      widthBefore
    )
    expect(await windowsShown(electronApp)).toEqual(shownBefore)
    await expect(orcaPage.getByRole('heading', { name: 'Tasks' })).toBeVisible()

    // After a save, a shot waits for the new code: a broken save reports its located load error.
    const panelFile = join(pluginRoot, 'src', 'panel.tsx')
    const source = await readFile(panelFile, 'utf8')
    const saved = async (contents: string): Promise<void> => {
      const before = await devChangeCount(orcaPage, pluginKey)
      await writeFile(panelFile, contents)
      await expect
        .poll(() => devChangeCount(orcaPage, pluginKey), { timeout: 15_000 })
        .toBeGreaterThan(before)
    }
    await saved("import { atom } from 'orca'\n\nconst = 1\n")
    const broken = await orcaCliResult<Shot>(userDataDir, [
      'plugin',
      'shot',
      pluginKey,
      '--out',
      join(tempRoot, 'broken.png')
    ])
    expect(broken.settled).toBe(true)
    expect(broken.errors.join('\n')).toContain('src/panel.tsx:3')
    await saved(source)
    const fixed = await orcaCliResult<Shot>(userDataDir, [
      'plugin',
      'shot',
      pluginKey,
      '--out',
      join(tempRoot, 'fixed.png')
    ])
    expect(fixed).toMatchObject({ settled: true, errors: [] })
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('plugin shot includes an html panel guest and plugin open shows a panel', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-shot-html-'))
  const pluginRoot = join(tempRoot, 'red-frame')
  try {
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      join(pluginRoot, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'sandboxed-ui',
        id: 'red-frame',
        name: 'Red Frame',
        version: '1.0.0',
        engines: { orca: '>=1.4.246' },
        pluginApi: 1,
        contributes: {
          panels: [
            { id: 'page', title: 'Red Frame', entry: 'page.html' },
            { id: 'other', title: 'Other Frame', entry: 'page.html' }
          ]
        }
      })
    )
    await writeFile(
      join(pluginRoot, 'page.html'),
      '<!doctype html><html><body style="margin:0;background:rgb(255,0,0);height:100vh"></body></html>'
    )
    await enableDevPlugins(orcaPage, [pluginRoot])
    const pluginKey = await devPluginKey(orcaPage, 'Red Frame')
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))

    const opened = await orcaCliResult<{ kind: string; panelId: string }>(userDataDir, [
      'plugin',
      'open',
      pluginKey,
      '--panel',
      'other'
    ])
    expect(opened).toMatchObject({ kind: 'panel', panelId: 'other' })
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().rightSidebarTab))
      .toBe(`plugin:${pluginKey}/other`)

    const shot = await orcaCliResult<Shot>(userDataDir, [
      'plugin',
      'shot',
      pluginKey,
      '--out',
      join(tempRoot, 'red.png')
    ])
    expect(shot).toMatchObject({ panelId: 'page', settled: true })
    // The guest is a separate process; its page is in the capture, not a blank box.
    expect((await pngStats(electronApp, shot.path)).redShare).toBeGreaterThan(0.8)
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
