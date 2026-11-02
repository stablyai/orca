/**
 * Invariant: `orca plugin shot` captures exactly a plugin panel as Orca draws it, from the hidden
 * test window, without showing or focusing it: a components panel (Orca's own DOM) at the asked
 * width and theme, after `--act` input when asked, and an html panel whose isolated guest content
 * is in the image. `--scenario` captures a `.check.ts` scenario drawn apart from the plugin, so
 * its data never reaches the live panel, the plugin's storage or its worker.
 */

import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { orcaCliResult, runCompiledOrcaCli } from './helpers/compiled-orca-cli'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import { createPluginFromTemplate } from '../../src/cli/plugin-authoring/plugin-create'
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

test('plugin shot includes an html panel guest, plugin open shows a panel, and ifShown never switches', async ({
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

    // `dev watch --shot` asks with ifShown: another tab on screen is skipped, never switched.
    const client = new RuntimeClient(userDataDir, 30_000, null, null)
    const pageTab = `plugin:${pluginKey}/page`
    const away = await client.call<{ notShown?: string }>('plugins.shot', {
      pluginKey,
      panelId: 'other',
      ifShown: true
    })
    expect(away.result.notShown).toBe('the right sidebar shows another tab')
    expect(await orcaPage.evaluate(() => window.__store?.getState().rightSidebarTab)).toBe(pageTab)
    const shown = await client.call<{ png?: string; panelId: string }>('plugins.shot', {
      pluginKey,
      panelId: 'page',
      ifShown: true
    })
    expect(shown.result).toMatchObject({ panelId: 'page' })
    expect(shown.result.png?.length).toBeGreaterThan(0)
    // --act drives components panels only.
    await expect(
      client.call('plugins.shot', { pluginKey, acts: [{ press: { text: 'Go' } }] })
    ).rejects.toThrow(/components panels only/)
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('plugin shot --act types and presses on the hidden components panel before capturing', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-shot-act-'))
  const pluginRoot = join(tempRoot, 'hello-tsx')
  try {
    await cp(join(process.cwd(), 'examples', 'plugins', 'hello-tsx'), pluginRoot, {
      recursive: true
    })
    await enableDevPlugins(orcaPage, [pluginRoot])
    const pluginKey = await devPluginKey(orcaPage, 'Hello TSX')
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const shownBefore = await windowsShown(electronApp)
    const client = new RuntimeClient(userDataDir, 60_000, null, null)
    type ActShot = {
      png: string
      errors: string[]
      actions?: { ok: boolean; error?: string }[]
      restored?: boolean
    }

    const before = await client.call<ActShot>('plugins.shot', { pluginKey, width: 360 })
    // Orca's floating launcher parks over the sidebar; a capture hides it so it is never in a shot.
    const launcher = orcaPage.locator('[data-floating-terminal-toggle]')
    const launchers = await launcher.count()
    const pending = client.call<ActShot>(
      'plugins.shot',
      {
        pluginKey,
        width: 360,
        acts: [
          { type: { label: 'New task' }, text: 'Ship the act' },
          { press: { label: 'Add task' } },
          { press: { label: 'Ship the act' } },
          { press: { text: 'Nothing here' } },
          { press: { label: 'Add task' } }
        ]
      },
      { timeoutMs: 60_000 }
    )
    if (launchers > 0) {
      await expect.poll(() => launcher.count()).toBe(0)
    }
    const acted = await pending
    expect(acted.result.actions).toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
      { ok: false, error: 'press: nothing in the panel matches { text: "Nothing here" }' },
      { ok: false, error: 'not run: an earlier action failed' }
    ])
    expect(acted.result.errors).toEqual([])
    // The shot shows the acted panel; afterwards the persisted list and the draft are put back.
    expect(acted.result.png).not.toBe(before.result.png)
    expect(acted.result.restored).toBe(true)
    await expect(orcaPage.getByRole('heading', { name: 'Tasks' })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /Ship the act/ })).toHaveCount(0)
    await expect(orcaPage.getByRole('textbox', { name: 'New task' })).toHaveValue('')
    // The launcher is back once the capture ended; the window never showed.
    await expect.poll(() => launcher.count()).toBe(launchers)
    expect(await windowsShown(electronApp)).toEqual(shownBefore)
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('plugin shot waits for a cold worker, and --act state is put back after the capture', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-shot-worker-'))
  try {
    const created = await createPluginFromTemplate({
      dir: join(tempRoot, 'shot-counter'),
      template: 'worker-panel',
      id: 'shot-counter',
      name: 'Shot Counter'
    })
    await enableDevPlugins(orcaPage, [created.path])
    const pluginKey = await devPluginKey(orcaPage, 'Shot Counter')
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const client = new RuntimeClient(userDataDir, 60_000, null, null)
    type WorkerShot = {
      panelId: string
      pendingRequests?: number
      actions?: { ok: boolean; error?: string }[]
      restored?: boolean
    }

    // The first shot starts the panel and its worker: it waits for counter.get's answer.
    const cold = await client.call<WorkerShot>('plugins.shot', { pluginKey })
    expect(cold.result.pendingRequests).toBe(0)
    const surface = orcaPage.locator(
      `[data-plugin-panel-surface="plugin:${pluginKey}/${cold.result.panelId}"]`
    )
    // Read at once, no retry: the capture already showed the worker's total, not the placeholder.
    expect(await surface.innerText()).toMatch(/Counter\s+0\b/)

    // `step` is persisted ('plugin'): the act flips it for the shot only.
    const acted = await client.call<WorkerShot>(
      'plugins.shot',
      { pluginKey, acts: [{ press: { text: 'Step 10' } }] },
      { timeoutMs: 60_000 }
    )
    expect(acted.result).toMatchObject({ actions: [{ ok: true }], restored: true })
    await expect(surface.getByRole('button', { name: 'Add 1' })).toBeVisible()
    const later = await client.call<WorkerShot>('plugins.shot', { pluginKey })
    expect(later.result.pendingRequests).toBe(0)
    await expect(surface.getByRole('button', { name: 'Add 1' })).toBeVisible()
    await expect(surface.getByRole('button', { name: 'Step 10' })).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('plugin shot --act sorts and activates a Table row, then puts the panel back', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-shot-table-'))
  const pluginRoot = join(tempRoot, 'shot-table')
  try {
    await mkdir(join(pluginRoot, 'src'), { recursive: true })
    await writeFile(
      join(pluginRoot, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'sandboxed-ui',
        id: 'shot-table',
        name: 'Shot Table',
        version: '1.0.0',
        engines: { orca: '>=1.4.246' },
        pluginApi: 1,
        contributes: {
          panels: [{ id: 'files', title: 'Shot Table', entry: 'src/panel.tsx', ui: 'components' }]
        },
        capabilities: []
      })
    )
    await writeFile(
      join(pluginRoot, 'src', 'panel.tsx'),
      [
        "import { atom, read, set, Stack, Table, Text } from 'orca'",
        "const sort = atom({ column: 'name', direction: 'asc' })",
        "const opened = atom('none')",
        'export default function Panel() {',
        '  const by = read(sort)',
        "  const names = ['alpha', 'beta', 'gamma'].sort()",
        "  if (by.direction === 'desc') names.reverse()",
        '  return (',
        '    <Stack>',
        '      <Text>{`Sorted ${by.direction}, opened ${read(opened)}`}</Text>',
        '      <Table',
        '        label="Files"',
        "        columns={[{ key: 'name', label: 'Name', sortable: true }]}",
        '        rows={names.map((name) => ({ key: name, cells: { name } }))}',
        '        sort={by}',
        '        onSortChange={(next) => set(sort, next)}',
        '        onRowAction={({ key }) => set(opened, key)}',
        '      />',
        '    </Stack>',
        '  )',
        '}',
        ''
      ].join('\n')
    )
    await enableDevPlugins(orcaPage, [pluginRoot])
    const pluginKey = await devPluginKey(orcaPage, 'Shot Table')
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const client = new RuntimeClient(userDataDir, 60_000, null, null)
    type TableShot = { png: string; actions?: { ok: boolean }[]; restored?: boolean }

    const before = await client.call<TableShot>('plugins.shot', { pluginKey })
    await expect(orcaPage.getByText('Sorted asc, opened none')).toBeVisible()
    const table = { label: 'Files' }
    const acted = await client.call<TableShot>(
      'plugins.shot',
      {
        pluginKey,
        acts: [
          { sort: table, column: 'name' },
          { activateRow: table, key: 'gamma' }
        ]
      },
      { timeoutMs: 60_000 }
    )
    expect(acted.result).toMatchObject({ actions: [{ ok: true }, { ok: true }], restored: true })
    expect(acted.result.png).not.toBe(before.result.png)
    await expect(orcaPage.getByText('Sorted asc, opened none')).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})

/** Every file under the plugins' data folder with its bytes: a shot must leave all of it alone. */
async function pluginDataFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      files[path] = await readFile(path, 'base64')
    }
  }
  return files
}

test('plugin shot --scenario captures a check scenario apart from the live panel, storage and worker', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-shot-scenario-'))
  try {
    const created = await createPluginFromTemplate({
      dir: join(tempRoot, 'scenario-counter'),
      template: 'worker-panel',
      id: 'scenario-counter',
      name: 'Scenario Counter'
    })
    await enableDevPlugins(orcaPage, [created.path])
    const pluginKey = await devPluginKey(orcaPage, 'Scenario Counter')
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const statusOf = async (): Promise<string | undefined> =>
      (await orcaPage.evaluate(() => window.api.plugins.list())).find(
        (plugin) => plugin.pluginKey === pluginKey
      )?.status
    const sidebar = () =>
      orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        return { open: state?.rightSidebarOpen, tab: state?.rightSidebarTab }
      })
    const dataRoot = join(userDataDir, 'plugins-data')
    const sidebarBefore = await sidebar()
    const dataBefore = await pluginDataFiles(dataRoot)
    const shownBefore = await windowsShown(electronApp)
    expect(await statusOf()).toBe('idle')

    type ScenarioShot = Shot & { replay: true; scenario: string; notes: string[] }
    const shot = await orcaCliResult<ScenarioShot>(userDataDir, [
      'plugin',
      'shot',
      created.path,
      '--scenario',
      'counted',
      '--width',
      '320',
      '--theme',
      'dark',
      '--out',
      join(tempRoot, 'counted.png')
    ])
    expect(shot).toMatchObject({
      replay: true,
      scenario: 'counted',
      width: 320,
      theme: 'dark',
      themeApplied: true,
      errors: []
    })
    const stats = await pngStats(electronApp, shot.path)
    expect(stats).toMatchObject({ width: 320, height: shot.height })
    // A heading, a badge and buttons: not a blank or single-color capture.
    expect(stats.colors).toBeGreaterThan(20)

    // The scenario's data stayed in the CLI's stand-in host: no live panel, storage or worker.
    expect(await sidebar()).toEqual(sidebarBefore)
    expect(await pluginDataFiles(dataRoot)).toEqual(dataBefore)
    expect(await statusOf()).toBe('idle')
    expect(await orcaPage.locator('[data-plugin-shot-replay]').count()).toBe(0)
    expect(
      await orcaPage.locator(`[data-plugin-panel-surface^="plugin:${pluginKey}/"]`).count()
    ).toBe(0)
    expect(await windowsShown(electronApp)).toEqual(shownBefore)

    // An unknown scenario fails and names the ones the panel has.
    const unknown = await runCompiledOrcaCli(userDataDir, [
      'plugin',
      'shot',
      created.path,
      '--scenario',
      'nope',
      '--json'
    ])
    expect(unknown.code).not.toBe(0)
    expect(unknown.json?.error?.message).toMatch(/its scenarios: fresh, counted/)
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
