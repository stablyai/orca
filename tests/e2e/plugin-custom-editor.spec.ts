/**
 * Invariant: a plugin custom editor opens matching files in the editor tab, edits (text or
 * bytes) flow into Orca's buffer without dirtying it on open, the save shortcut pressed inside
 * the frame saves through Orca, Source shows the same buffer (or the binary placeholder), and
 * turning plugins off falls back to Source.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins, openRepoFile } from './helpers/plugin-smoke'

const FILE = 'custom-editor-smoke.sketch'
const FRAME = 'iframe[title="Sketch Pad"]'

// A tiny complete editor on window.orca: a textarea that sends debounced full-text edits.
const EDITOR_HTML = `<textarea id="doc" style="width:100%;height:90vh"></textarea>
<script>
const doc = document.getElementById('doc')
let timer = null
let version = 0
const flush = () => {
  clearTimeout(timer); timer = null
  return orca.document.applyEdit({ baseVersion: version, content: { kind: 'text', text: doc.value } })
}
doc.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(flush, 400) })
orca.document.onDidChange((next) => {
  version = next.version; doc.value = next.content.text; doc.readOnly = next.readOnly
})
orca.on('editor.flush', () => (timer ? flush() : undefined))
</script>`

async function writeEditorPlugin(root: string): Promise<void> {
  await mkdir(join(root, 'editor'), { recursive: true })
  await writeFile(join(root, 'editor', 'index.html'), EDITOR_HTML)
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
          {
            id: 'sketch',
            title: 'Sketch Pad',
            extensions: ['.sketch'],
            entry: 'editor/index.html'
          }
        ]
      }
    })
  )
}

function activeFileDirty(page: Page): Promise<boolean | undefined> {
  return page.evaluate((name) => {
    const state = window.__store?.getState()
    return state?.openFiles.find((file) => file.relativePath === name)?.isDirty
  }, FILE)
}

async function chooseView(page: Page, label: string): Promise<void> {
  await page.getByRole('radio', { name: label, exact: true }).click()
}

test('plugin custom editor edits and saves through Orca', async ({ orcaPage, seededRepoPath }) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-custom-editor-'))
  const filePath = join(seededRepoPath, FILE)
  try {
    await writeEditorPlugin(pluginRoot)
    await writeFile(filePath, 'first line\n')
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openRepoFile(orcaPage, seededRepoPath, FILE)

    const frame = orcaPage.frameLocator(FRAME)
    const textarea = frame.locator('#doc')
    await expect(textarea).toHaveValue('first line\n', { timeout: 15_000 })
    // Opening a file in its custom editor must not dirty it.
    expect(await activeFileDirty(orcaPage)).toBe(false)

    await textarea.click()
    await textarea.press('End')
    await textarea.pressSequentially('second line')
    await expect.poll(() => activeFileDirty(orcaPage)).toBe(true)

    // Saved inside the debounce window: Orca must flush the frame first.
    await textarea.pressSequentially('!')
    await textarea.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect.poll(() => readFile(filePath, 'utf8')).toBe('first line\nsecond line!')
    await expect.poll(() => activeFileDirty(orcaPage)).toBe(false)

    await chooseView(orcaPage, 'Source')
    await expect(orcaPage.locator(FRAME)).toHaveCount(0)
    await expect(orcaPage.locator('.monaco-editor .view-lines')).toContainText('second line!')
    await chooseView(orcaPage, 'Sketch Pad')
    await expect(textarea).toHaveValue('first line\nsecond line!')

    await disablePluginSystem(orcaPage)
    await expect(orcaPage.locator(FRAME)).toHaveCount(0, { timeout: 15_000 })
    await expect(orcaPage.locator('.monaco-editor .view-lines')).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(filePath, { force: true })
    await rm(pluginRoot, { recursive: true, force: true })
  }
})

const BYTES_FILE = 'custom-editor-smoke.hexbook'
const BYTES_FRAME = 'iframe[title="Hex Book"]'

// Reports what a bytes editor receives; its button appends 0xaa as a full-bytes edit.
const BYTES_EDITOR_HTML = `<output id="summary">waiting</output><button id="append">Append</button>
<script>
let version = 0
let bytes = new Uint8Array()
const summary = document.getElementById('summary')
orca.document.onDidChange((doc) => {
  if (doc.content.kind !== 'bytes') return
  version = doc.version
  bytes = new Uint8Array(doc.content.bytes)
  summary.textContent =
    'v' + doc.version + ' ' + doc.fileType + ' ' + doc.readOnly + ' ' + bytes.length + ':' +
    Array.from(bytes.slice(0, 4), (byte) => byte.toString(16)).join(' ') +
    ' name=' + (window.name.includes('hexbook') ? 'leaks' : 'opaque')
  // A text edit is the wrong kind for a bytes document: Orca refuses it.
  orca.document.applyEdit({ baseVersion: version, content: { kind: 'text', text: 'x' } }).catch(() => {})
})
document.getElementById('append').addEventListener('click', () => {
  const next = new Uint8Array(bytes.length + 1)
  next.set(bytes)
  next[bytes.length] = 0xaa
  bytes = next
  orca.document.applyEdit({ baseVersion: version, content: { kind: 'bytes', bytes: next.slice().buffer } })
})
</script>`

test('a bytes custom editor edits and saves a binary file', async ({
  orcaPage,
  seededRepoPath
}) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-bytes-editor-'))
  const filePath = join(seededRepoPath, BYTES_FILE)
  // NULs make Orca treat it as binary, like a zip-based workbook.
  const original = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0x10])
  try {
    await mkdir(join(pluginRoot, 'editor'), { recursive: true })
    await writeFile(join(pluginRoot, 'editor', 'index.html'), BYTES_EDITOR_HTML)
    await writeFile(
      join(pluginRoot, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'sandboxed-ui',
        id: 'hex-book',
        publisher: 'samples',
        name: 'Hex Book',
        version: '1.0.0',
        engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
        contributes: {
          customEditors: [
            {
              id: 'hex',
              title: 'Hex Book',
              extensions: ['.hexbook'],
              entry: 'editor/index.html',
              contentKind: 'bytes'
            }
          ]
        }
      })
    )
    await writeFile(filePath, original)
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openRepoFile(orcaPage, seededRepoPath, BYTES_FILE)

    const bytesFrame = orcaPage.frameLocator(BYTES_FRAME)
    const summary = bytesFrame.locator('#summary')
    await expect(summary).toHaveText('v1 hexbook false 8:50 4b 3 4 name=opaque', {
      timeout: 15_000
    })
    // Opening and the ignored text edit leave the file and the tab untouched.
    const dirty = () =>
      orcaPage.evaluate(
        (name) =>
          window.__store?.getState().openFiles.find((file) => file.relativePath === name)?.isDirty,
        BYTES_FILE
      )
    expect(await readFile(filePath)).toEqual(original)
    expect(await dirty()).toBe(false)

    const append = bytesFrame.locator('#append')
    // Why a key: in a hidden Linux window the mouse never reaches a sandboxed frame's button.
    await append.press('Enter')
    await expect.poll(dirty).toBe(true)
    await append.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    const edited = Buffer.concat([original, Buffer.from([0xaa])])
    await expect.poll(() => readFile(filePath)).toEqual(edited)
    await expect.poll(dirty).toBe(false)

    // Source of a binary file is the binary placeholder, never decoded bytes.
    await chooseView(orcaPage, 'Source')
    await expect(orcaPage.locator(BYTES_FRAME)).toHaveCount(0)
    await expect(orcaPage.getByText('Binary file — cannot display')).toBeVisible()
    await chooseView(orcaPage, 'Hex Book')
    // A remount reads the saved bytes back.
    await expect(summary).toContainText('hexbook false 9:')

    await disablePluginSystem(orcaPage)
    await expect(orcaPage.locator(BYTES_FRAME)).toHaveCount(0, { timeout: 15_000 })
    await expect(orcaPage.getByText('Binary file — cannot display')).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(filePath, { force: true })
    await rm(pluginRoot, { recursive: true, force: true })
  }
})
