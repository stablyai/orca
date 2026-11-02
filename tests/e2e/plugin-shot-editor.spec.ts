/**
 * Invariant: `orca plugin shot --editor` opens a file in a plugin's custom editor from the hidden
 * test window, waits for the editor to get and ask for its document, sends `--act` input into the
 * editor's isolated guest, and captures what it drew without showing or focusing the window. A
 * file no workspace holds opens its folder as a folder workspace; an editor that never asks for its
 * document, or throws, fails the command.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { runCompiledOrcaCli } from './helpers/compiled-orca-cli'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import { ISOLATED_FRAMES_E2E } from './helpers/plugin-frame-guest'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.use(ISOLATED_FRAMES_E2E)

// Red after a click anywhere, so the image proves the act reached the guest before the capture.
const EDITOR_HTML = `<!doctype html>
<html><body style="margin:0">
<div id="box" style="width:100vw;height:100vh;background:#123456"></div>
<script>
  orca.document.onDidChange(() => {})
  document.addEventListener('mousedown', () => {
    document.getElementById('box').style.background = '#ff0000'
  })
</script>
</body></html>`

const BROKEN_HTML = `<!doctype html><html><body><script>throw new Error('editor exploded')</script></body></html>`

/** Share of pure red pixels, decoded in Electron's main process. */
function redShare(app: ElectronApplication, path: string): Promise<number> {
  return app.evaluate(({ nativeImage }, file) => {
    const bgra = nativeImage.createFromPath(file).toBitmap()
    let red = 0
    for (let at = 0; at + 3 < bgra.length; at += 4) {
      if ((bgra[at + 2] ?? 0) > 200 && (bgra[at + 1] ?? 0) < 60 && (bgra[at] ?? 0) < 60) {
        red += 1
      }
    }
    return red / Math.max(1, bgra.length / 4)
  }, path)
}

async function editorPlugin(root: string, id: string, extension: string, html: string) {
  await mkdir(join(root, id, 'editor'), { recursive: true })
  await writeFile(
    join(root, id, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id,
      name: id,
      version: '1.0.0',
      engines: { orca: '>=1.4.246' },
      pluginApi: 1,
      contributes: {
        customEditors: [{ id, title: id, extensions: [extension], entry: 'editor/index.html' }]
      }
    })
  )
  await writeFile(join(root, id, 'editor', 'index.html'), html)
  return join(root, id)
}

test('plugin shot --editor opens the file, acts in the guest and fails a broken editor', async ({
  electronApp,
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-editor-shot-'))
  try {
    const good = await editorPlugin(tempRoot, 'red-click', '.redclick', EDITOR_HTML)
    const broken = await editorPlugin(tempRoot, 'broken-editor', '.broken', BROKEN_HTML)
    // Outside every workspace: the shot opens this folder as a folder workspace.
    const docs = join(tempRoot, 'docs')
    await mkdir(docs)
    await writeFile(join(docs, 'a.redclick'), 'x')
    await writeFile(join(docs, 'b.broken'), 'x')
    await enableDevPlugins(orcaPage, [good, broken])
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))

    await expect
      .poll(
        async () => {
          const run = await runCompiledOrcaCli(userDataDir, [
            'plugin',
            'shot',
            'local.red-click',
            '--editor',
            join(docs, 'a.redclick'),
            '--width',
            '320',
            '--height',
            '200',
            '--act',
            '[{"click":[20,20]}]',
            '--out',
            join(tempRoot, 'acted.png'),
            '--json'
          ])
          return run.json?.ok ? run.json.result : run.stderr
        },
        { timeout: 60_000, message: 'the editor shot never succeeded' }
      )
      .toMatchObject({ width: 320, height: 200, subscribed: true, errors: [], acted: 1 })
    expect(await redShare(electronApp, join(tempRoot, 'acted.png'))).toBeGreaterThan(0.9)
    expect(
      await electronApp.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused())
      )
    ).toBe(false)

    const failed = await runCompiledOrcaCli(userDataDir, [
      'plugin',
      'shot',
      'local.broken-editor',
      '--editor',
      join(docs, 'b.broken'),
      '--out',
      join(tempRoot, 'broken.png')
    ])
    expect(failed.code).toBe(1)
    expect(failed.stdout).toContain('never asked for its document')
    expect(failed.stdout).toContain('editor exploded')
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
