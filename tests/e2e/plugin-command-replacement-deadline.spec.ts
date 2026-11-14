/**
 * Invariant: a plugin command that replaces a built-in action (here `sidebar.left.toggle`) gets
 * the action exactly once per press. A fast handler that calls `commands.run` toggles it, a
 * handler that throws gets Orca's own toggle, a handler that never calls `commands.run` leaves
 * it alone, and a handler that calls `commands.run` after the 2 s deadline is refused because
 * Orca already ran its own: the sidebar never toggles twice.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'

type Mode = 'fast' | 'late' | 'throw' | 'noop'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    /** Left sidebar open/close changes the renderer committed, counted by this spec. */
    __sidebarToggles?: number
  }
}

const manifest = {
  manifestVersion: 2,
  execution: 'trusted-worker',
  id: 'e2e-sidebar-replacement',
  name: 'E2E Sidebar Replacement',
  version: '1.0.0',
  description: 'Replaces the left sidebar toggle with a handler whose timing the test picks.',
  engines: { orca: '>=1.4.248' },
  pluginApi: 1,
  main: 'worker.mjs',
  contributes: {
    commands: [{ id: 'toggle', title: 'Toggle sidebar', replaces: 'sidebar.left.toggle' }],
    settings: [
      {
        key: 'mode',
        title: 'Mode',
        type: 'string',
        enum: ['fast', 'late', 'throw', 'noop'],
        default: 'fast'
      },
      { key: 'logPath', title: 'Log path', type: 'string', default: '' }
    ]
  },
  capabilities: [{ kind: 'settings:own' }, { kind: 'workspace:write' }]
}

const worker = `import { appendFileSync } from 'node:fs'

export default function activate(orca) {
  orca.commands.register('toggle', async () => {
    const mode = await orca.settings.get('mode')
    const logPath = String((await orca.settings.get('logPath')) ?? '')
    const note = (line) => {
      if (logPath) appendFileSync(logPath, mode + ':' + line + '\\n')
    }
    note('start')
    if (mode === 'throw') {
      note('threw')
      throw new Error('replacement failed')
    }
    if (mode === 'noop') {
      note('done')
      return
    }
    if (mode === 'late') {
      await new Promise((resolve) => setTimeout(resolve, 2_100))
    }
    try {
      await orca.host.call('commands.run', { action: 'sidebar.left.toggle' })
      note('ran')
    } catch (error) {
      note('refused')
      throw error
    }
  })
}
`

async function setMode(page: Page, pluginKey: string, key: string, value: string): Promise<void> {
  await page.evaluate(
    async ({ pluginKey, key, value }) => {
      const written = await window.api.plugins.setSetting?.({ pluginKey, key, value })
      if (!written?.ok) {
        throw new Error(`setSetting failed: ${JSON.stringify(written)}`)
      }
    },
    { pluginKey, key, value }
  )
}

async function pressToggle(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ui:toggleLeftSidebar')
  })
}

function toggleCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__sidebarToggles ?? 0)
}

async function logLines(logPath: string, mode: Mode): Promise<string[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line.startsWith(`${mode}:`))
    .map((line) => line.slice(mode.length + 1))
}

test('a replacing command gets the left sidebar toggle exactly once, early, late or failing', async ({
  orcaPage,
  electronApp
}) => {
  // Why: four timed presses each wait out the 2 s deadline and 3 s safety net, plus plugin setup.
  test.setTimeout(120_000)
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-replacement-deadline-'))
  const pluginRoot = join(tempRoot, 'sidebar-replacement')
  const logPath = join(tempRoot, 'handler.log')
  try {
    await mkdir(pluginRoot)
    await writeFile(join(pluginRoot, 'orca-plugin.json'), JSON.stringify(manifest, null, 2))
    await writeFile(join(pluginRoot, 'worker.mjs'), worker)
    await enableDevPlugins(orcaPage, [pluginRoot])

    const pluginKey = await orcaPage.evaluate(async () => {
      const plugin = (await window.api.plugins.list()).find(
        (entry) => entry.name === 'E2E Sidebar Replacement'
      )
      if (!plugin) {
        throw new Error('plugin not discovered')
      }
      return plugin.pluginKey
    })
    // Starts the worker up front, so the timed cases below measure a warm handler. A dev plugin
    // can still be settling its first review right after approval, so retry until it runs.
    await expect
      .poll(
        () =>
          orcaPage.evaluate(async (key) => {
            const plugin = (await window.api.plugins.list()).find((p) => p.pluginKey === key)
            if (plugin?.status === 'pending' && plugin.consentFingerprint) {
              await window.api.plugins.consent({
                pluginKey: key,
                reviewedFingerprint: plugin.consentFingerprint,
                decision: 'approve'
              })
            }
            return window.api.plugins.invokeCommand({ pluginKey: key, commandId: 'toggle' }).then(
              () => 'ran',
              (error: unknown) => String(error)
            )
          }, pluginKey),
        { timeout: 30_000 }
      )
      .toBe('ran')
    await setMode(orcaPage, pluginKey, 'logPath', logPath)

    // Counts every open/close of the left sidebar the renderer actually commits.
    await orcaPage.evaluate(() => {
      window.__sidebarToggles = 0
      window.__store?.subscribe((state, previous) => {
        if (state.sidebarOpen !== previous.sidebarOpen) {
          window.__sidebarToggles = (window.__sidebarToggles ?? 0) + 1
        }
      })
    })

    // The renderer learns of the replacement through its plugin list; wait until a press reaches
    // the plugin (the fast handler runs the toggle itself) before measuring each mode.
    await expect(async () => {
      await pressToggle(electronApp)
      await expect.poll(() => logLines(logPath, 'fast'), { timeout: 2_000 }).toContain('ran')
    }).toPass({ timeout: 30_000 })
    await rm(logPath, { force: true })

    const cases: { mode: Mode; settle: number; toggles: number; log: string[] }[] = [
      { mode: 'fast', settle: 3_500, toggles: 1, log: ['start', 'ran'] },
      { mode: 'late', settle: 4_500, toggles: 1, log: ['start', 'refused'] },
      { mode: 'throw', settle: 3_500, toggles: 1, log: ['start', 'threw'] },
      { mode: 'noop', settle: 3_500, toggles: 0, log: ['start', 'done'] }
    ]
    for (const { mode, settle, toggles, log } of cases) {
      await setMode(orcaPage, pluginKey, 'mode', mode)
      const before = await toggleCount(orcaPage)
      const openBefore = await orcaPage.evaluate(() => window.__store?.getState().sidebarOpen)
      await pressToggle(electronApp)
      // Past the 2 s deadline and the renderer's 3 s safety net, so a second toggle would show:
      // the assertion is that nothing more happens, which no condition can wait for.
      // ast-grep-ignore: test-no-real-time-wait -- proves the absence of a late second toggle
      await orcaPage.waitForTimeout(settle)
      expect({ mode, toggles: (await toggleCount(orcaPage)) - before }).toEqual({ mode, toggles })
      expect({ mode, log: await logLines(logPath, mode) }).toEqual({ mode, log })
      const openAfter = await orcaPage.evaluate(() => window.__store?.getState().sidebarOpen)
      expect(openAfter).toBe(toggles === 1 ? !openBefore : openBefore)
    }
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
