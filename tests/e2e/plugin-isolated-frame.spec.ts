/**
 * Invariant: on desktop a plugin panel is an isolated `<webview>` guest on its own partition and
 * origin. A multi-file plugin loads scripts, styles, fonts, WASM and a worker by URL, keeps
 * localStorage across a reload, still talks to Orca through window.orca, and cannot reach the
 * network (a loopback HTTP listener sees nothing).
 */

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import {
  clickInGuest,
  evalInGuest,
  guestWebContentsId,
  pluginGuest,
  waitForGuestReady,
  ISOLATED_FRAMES_E2E
} from './helpers/plugin-frame-guest'

// Isolated frames are off by default; these journeys exercise the guest path.
test.use(ISOLATED_FRAMES_E2E)

const TITLE = 'Asset Probe'

// `(module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))`
const ADD_WASM = Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
  0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
  0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b
])

const PANEL_HTML = `<!doctype html>
<html><head>
<link rel="stylesheet" href="styles/panel.css">
</head><body>
<h1 id="title">Asset probe</h1>
<input type="file" id="pick">
<script type="module" src="lib/app.js"></script>
</body></html>`

const PANEL_CSS = `@font-face { font-family: Probe; src: url(../fonts/probe.ttf); }
#title { color: rgb(1, 2, 3); font-family: Probe, sans-serif; }`

const appScript = (leakUrl: string): string => `
const results = (window.__probe = { boots: 0 })
results.boots = Number(localStorage.getItem('boots') || '0') + 1
localStorage.setItem('boots', String(results.boots))
results.origin = location.origin
results.css = getComputedStyle(document.getElementById('title')).color
results.orca = typeof window.orca === 'object' && typeof window.orca.host.call === 'function'
const settle = async (name, run) => {
  try { results[name] = await run() } catch (error) { results[name] = 'error:' + (error && error.name) }
}
await Promise.all([
  settle('wasm', async () => {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL('./add.wasm', import.meta.url)))
    return instance.exports.add(2, 3)
  }),
  settle('worker', () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url))
    worker.onmessage = (event) => resolve(event.data)
    worker.onerror = () => reject(new Error('worker failed'))
    worker.postMessage(20)
  })),
  settle('font', async () => {
    await document.fonts.load('16px Probe')
    return document.fonts.check('16px Probe')
  }),
  settle('leak', async () => {
    await fetch(${JSON.stringify(leakUrl)})
    return 'escaped'
  }),
  settle('host', async () => {
    try { await window.orca.host.call('invalid.probe', {}) } catch (error) { return error.code }
    return 'unexpected'
  })
])
results.done = true
`

async function writeAssetPlugin(root: string, leakUrl: string): Promise<void> {
  await mkdir(join(root, 'styles'), { recursive: true })
  await mkdir(join(root, 'lib'), { recursive: true })
  await mkdir(join(root, 'fonts'), { recursive: true })
  await writeFile(join(root, 'index.html'), PANEL_HTML)
  await writeFile(join(root, 'styles', 'panel.css'), PANEL_CSS)
  await writeFile(join(root, 'lib', 'app.js'), appScript(leakUrl))
  await writeFile(
    join(root, 'lib', 'worker.js'),
    'onmessage = (event) => postMessage(event.data + 1)'
  )
  await writeFile(join(root, 'lib', 'add.wasm'), ADD_WASM)
  const monaco = dirname(
    createRequire(join(process.cwd(), 'package.json')).resolve('monaco-editor/package.json')
  )
  await copyFile(
    join(monaco, 'esm', 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon', 'codicon.ttf'),
    join(root, 'fonts', 'probe.ttf')
  )
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'asset-probe',
      publisher: 'samples',
      name: TITLE,
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      pluginApi: 1,
      contributes: {
        panels: [{ id: 'probe', title: TITLE, icon: 'bug', entry: 'index.html' }]
      }
    })
  )
}

async function openPanel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store?.getState()
    if (store && !store.rightSidebarOpen) {
      store.toggleRightSidebar()
    }
    await window.api.plugins.refresh()
  })
  const button = page.getByRole('button', { name: TITLE })
  await expect(button).toBeVisible({ timeout: 15_000 })
  await button.click()
}

type ProbeResults = {
  done?: boolean
  boots: number
  origin: string
  css: string
  orca: boolean
  wasm: unknown
  worker: unknown
  font: unknown
  leak: unknown
  host: unknown
}

test('a multi-file plugin panel runs as an isolated guest with assets by URL', async ({
  electronApp,
  orcaPage
}) => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '/')
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.end('leak')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('leak listener has no port')
  }
  const leakUrl = `http://127.0.0.1:${address.port}/leak`
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-asset-probe-'))
  try {
    await writeAssetPlugin(pluginRoot, leakUrl)
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openPanel(orcaPage)

    const guest = pluginGuest(orcaPage, TITLE)
    await expect(guest).toBeVisible({ timeout: 15_000 })
    await expect(guest).toHaveAttribute('partition', /^persist:orca-plugin-[0-9a-f]{16}$/)
    await expect(orcaPage.locator(`iframe[title="${TITLE}"]`)).toHaveCount(0)
    await waitForGuestReady(guest)

    const read = () => evalInGuest<ProbeResults | null>(guest, 'window.__probe ?? null')
    await expect.poll(async () => (await read())?.done, { timeout: 15_000 }).toBe(true)
    const first = await read()
    expect(first).toMatchObject({
      boots: 1,
      css: 'rgb(1, 2, 3)',
      orca: true,
      wasm: 5,
      worker: 21,
      font: true,
      leak: 'error:TypeError',
      // The host gated the call: the bridge works through the guest channel.
      host: 'unknown_method'
    })
    expect(first?.origin).toMatch(/^orca-plugin-frame:\/\/[0-9a-f]{16}$/)

    await guest.evaluate((webview: Electron.WebviewTag) => webview.reload())
    await expect.poll(async () => (await read())?.done, { timeout: 15_000 }).toBe(true)
    expect((await read())?.boots).toBe(2)
    expect(requests).toEqual([])

    // A file input reaches Electron's chooser; CDP intercepts it so no native dialog opens.
    await waitForGuestReady(guest)
    const guestId = await guestWebContentsId(guest)
    await electronApp.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (!contents) {
        throw new Error('plugin guest WebContents not found')
      }
      const record: string[] = []
      Reflect.set(globalThis, '__orcaFileChooser', record)
      contents.debugger.attach('1.3')
      contents.debugger.on('message', (_event, method) => record.push(method))
      await contents.debugger.sendCommand('Page.enable')
      await contents.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
    }, guestId)
    try {
      await clickInGuest(guest, '#pick')
      await expect
        .poll(() =>
          electronApp.evaluate(() => {
            const record: unknown = Object.getOwnPropertyDescriptor(
              globalThis,
              '__orcaFileChooser'
            )?.value
            return Array.isArray(record) && record.includes('Page.fileChooserOpened')
          })
        )
        .toBe(true)
    } finally {
      await electronApp.evaluate(({ webContents }, id) => {
        webContents.fromId(id)?.debugger.detach()
      }, guestId)
    }
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(pluginRoot, { recursive: true, force: true })
  }
})

test.describe('with isolated frames turned off', () => {
  test.use({ orcaAppExtraEnv: { ORCA_PLUGIN_ISOLATED_FRAMES: '0' } })

  test('a plugin panel keeps the srcdoc iframe and is offered no gesture methods', async ({
    orcaPage
  }) => {
    const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-srcdoc-panel-'))
    try {
      await writeAssetPlugin(pluginRoot, 'http://127.0.0.1:9/leak')
      await enableDevPlugins(orcaPage, [pluginRoot])
      await openPanel(orcaPage)
      const iframe = orcaPage.locator(`iframe[title="${TITLE}"]`)
      await expect(iframe).toBeVisible({ timeout: 15_000 })
      await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
      await expect(pluginGuest(orcaPage, TITLE)).toHaveCount(0)
      const api = await orcaPage
        .frameLocator(`iframe[title="${TITLE}"]`)
        .locator('html')
        .evaluate(() => {
          const orca: unknown = 'orca' in window ? window.orca : undefined
          if (typeof orca !== 'object' || orca === null) {
            return { shell: 'missing', files: 'missing', hasOpenExternal: 'missing' }
          }
          const host = 'host' in orca ? orca.host : undefined
          const has =
            typeof host === 'object' && host !== null && 'has' in host ? host.has : undefined
          return {
            shell: typeof ('shell' in orca ? orca.shell : undefined),
            files: typeof ('files' in orca ? orca.files : undefined),
            hasOpenExternal: typeof has === 'function' ? has('shell.openExternal') : 'missing'
          }
        })
      expect(api).toEqual({ shell: 'undefined', files: 'undefined', hasOpenExternal: false })
    } finally {
      await disablePluginSystem(orcaPage).catch(() => undefined)
      await rm(pluginRoot, { recursive: true, force: true })
    }
  })
})
