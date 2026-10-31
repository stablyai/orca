/**
 * Invariant: a plugin's new-file type appears in the tab bar + menu, creates an untitled file of
 * its extension at the workspace root seeded with its template, and opens it in the plugin's
 * custom editor, whose tab shows the editor's icon and hover card its name.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'

const TEMPLATE = '{"type":"sketch","elements":[]}\n'
const FRAME = 'iframe[title="Sketch Pad"]'

const EDITOR_HTML = `<textarea id="doc" style="width:100%;height:90vh"></textarea>
<script>
const doc = document.getElementById('doc')
orca.document.onDidChange((next) => { doc.value = next.content.text })
</script>`

function crc32(bytes: Buffer): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return ~crc >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A square RGB PNG, the size plugin icons must be. */
function solidPng(edge: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(edge, 0)
  header.writeUInt32BE(edge, 4)
  header[8] = 8
  header[9] = 2
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.concat(Array.from({ length: edge }, () => Buffer.from(rgb)))
  ])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: edge }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

async function writeSketchPlugin(root: string): Promise<void> {
  await mkdir(join(root, 'editor'), { recursive: true })
  await mkdir(join(root, 'templates'), { recursive: true })
  await writeFile(join(root, 'editor', 'index.html'), EDITOR_HTML)
  await writeFile(join(root, 'templates', 'empty.sketch'), TEMPLATE)
  await writeFile(join(root, 'tab.png'), solidPng(128, [0x6d, 0x5d, 0xfc]))
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
            icon: 'tab.png',
            extensions: ['.sketch'],
            entry: 'editor/index.html'
          }
        ],
        newFiles: [
          {
            id: 'sketch',
            title: 'New sketch',
            extension: '.sketch',
            template: 'templates/empty.sketch',
            icon: 'tab.png'
          }
        ]
      }
    })
  )
}

test('a plugin new file is created from the + menu and opens in its editor', async ({
  orcaPage,
  seededRepoPath
}) => {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'orca-new-file-'))
  const filePath = join(seededRepoPath, 'untitled.sketch')
  try {
    await writeSketchPlugin(pluginRoot)
    await enableDevPlugins(orcaPage, [pluginRoot])

    await orcaPage.getByRole('button', { name: 'New tab' }).first().click()
    const item = orcaPage.getByRole('menuitem', { name: 'New sketch' })
    await expect(item).toBeVisible({ timeout: 15_000 })
    await expect(item.locator('img[src^="orca-plugin-image://"]')).toBeVisible()
    await item.click()

    await expect.poll(() => readFile(filePath, 'utf8').catch(() => null)).toBe(TEMPLATE)
    await expect(orcaPage.frameLocator(FRAME).locator('#doc')).toHaveValue(TEMPLATE, {
      timeout: 15_000
    })

    const tab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'untitled.sketch' }).first()
    const icon = tab.locator('img[src*="/editor-0"]')
    await expect(icon).toBeVisible()
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(filePath, { force: true })
    await rm(pluginRoot, { recursive: true, force: true })
  }
})
