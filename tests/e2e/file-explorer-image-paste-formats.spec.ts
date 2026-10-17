import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { prepareImagePasteFolder } from './helpers/explorer-image-paste'
import { captureSystemImageClipboard } from './helpers/system-image-clipboard'

test('Windows mixed system clipboard preserves editable paste and imports pixels only', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  test.skip(
    process.platform !== 'win32' || process.env.ORCA_E2E_SYSTEM_CLIPBOARD_IMAGE !== '1',
    'Requires Windows and explicit system clipboard opt-in; run with --workers=1.'
  )
  const { destination, row, folder } = await prepareImagePasteFolder(page, 'mixed-system-image')
  const lease = await captureSystemImageClipboard(electronApp)
  try {
    const mixed = await lease.evaluate((clipboard) => clipboard.write('mixed'))
    expect(mixed.formats).toEqual(expect.arrayContaining(['text/plain', 'text/html', 'image/png']))
    expect(mixed.png).not.toBe('')
    await folder.click()
    await folder.press('Control+v')
    await expect(row('pasted-image.png')).toHaveAttribute('data-selected', 'true')
    const imageReads = await lease.evaluate((clipboard) => clipboard.bufferReads())
    expect(imageReads).toBeGreaterThan(0)
    expect(await readFile(path.join(destination, 'pasted-image.png'))).toEqual(
      Buffer.from(mixed.png, 'base64')
    )

    await row('pasted-image.png').click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Rename/ }).click()
    const rename = page.locator('[data-orca-explorer-shell] input.border-ring')
    await expect(rename).toBeFocused()
    await rename.fill('')
    await rename.press('Control+v')
    await expect(rename).toHaveValue(mixed.text)
    expect(await lease.evaluate((clipboard) => clipboard.bufferReads())).toBe(imageReads)
    await rename.press('Escape')

    // A textbox outside the explorer must also retain paste ownership after selection.
    const tab = page.locator('[data-testid="sortable-tab"]').first()
    await tab.dblclick()
    const tabRename = page.getByRole('textbox', { name: /^Rename tab / })
    await tabRename.fill('')
    await tabRename.press('Control+v')
    await expect(tabRename).toHaveValue(mixed.text)
    expect(await lease.evaluate((clipboard) => clipboard.bufferReads())).toBe(imageReads)
    await tabRename.press('Escape')
    expect(await readdir(destination)).toEqual(['pasted-image.png'])

    const evidence = [{ kind: 'mixed', ...mixed }]
    for (const kind of ['html', 'text', 'empty'] as const) {
      const snapshot = await lease.evaluate((clipboard, value) => clipboard.write(value), kind)
      evidence.push({ kind, ...snapshot })
      expect(snapshot.png).toBe('')
      const before = await lease.evaluate((clipboard) => clipboard.bufferReads())
      await folder.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /Paste Image/ }).click()
      // These snapshots are rejected synchronously before any filesystem work.
      await expect
        .poll(() => lease.evaluate((clipboard) => clipboard.bufferReads()))
        .toBeGreaterThan(before)
      expect(await readdir(destination)).toEqual(['pasted-image.png'])
    }
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: /Paste Image/ })).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('mixed-clipboard-explorer.png') })
    await testInfo.attach('pasted-image.png', {
      body: await readFile(path.join(destination, 'pasted-image.png')),
      contentType: 'image/png'
    })
    await testInfo.attach('system-clipboard-formats.json', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json'
    })
  } finally {
    const restored = await lease.evaluate((clipboard) => clipboard.restore())
    testInfo.annotations.push({ type: 'clipboard-restored', description: String(restored) })
    await lease.dispose()
  }
})

for (const source of ['file-name', 'shell-file-list'] as const) {
  test(`Windows ${source} with image preview is not converted to PNG (controlled reads)`, async ({
    orcaPage: page,
    electronApp
  }, testInfo) => {
    test.skip(process.platform !== 'win32', 'Windows file clipboard formats.')
    const { destination, row, folder } = await prepareImagePasteFolder(page, source)
    const jpeg = await electronApp.evaluate(({ nativeImage }) =>
      nativeImage
        .createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 })
        .toJPEG(90)
        .toString('base64')
    )
    const original = Buffer.from(jpeg, 'base64')
    const originalPath = path.join(destination, 'original.jpg')
    await writeFile(originalPath, original)
    const reads = await electronApp.evaluateHandle(
      ({ clipboard, nativeImage }, args) => {
        const originalReads = {
          readBuffer: clipboard.readBuffer,
          readImage: clipboard.readImage,
          availableFormats: clipboard.availableFormats,
          has: clipboard.has
        }
        let imageReads = 0
        let bufferReads = 0
        const preview = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), {
          width: 1,
          height: 1
        })
        const shellItems = Buffer.alloc(16)
        shellItems.writeUInt32LE(2)
        clipboard.availableFormats = () => [
          'image/png',
          'FileNameW',
          'text/html',
          ...(args.source === 'shell-file-list' ? ['Shell IDList Array'] : [])
        ]
        clipboard.has = (format) => clipboard.availableFormats().includes(format)
        clipboard.readBuffer = (format) => {
          bufferReads++
          if (format === 'FileNameW') {
            return Buffer.from(`${args.originalPath}\0`, 'utf16le')
          }
          return format === 'Shell IDList Array' && args.source === 'shell-file-list'
            ? shellItems
            : Buffer.alloc(0)
        }
        clipboard.readImage = () => {
          imageReads++
          return preview
        }
        return {
          imageReads: () => imageReads,
          bufferReads: () => bufferReads,
          restore: () => Object.assign(clipboard, originalReads)
        }
      },
      { source, originalPath }
    )
    try {
      await folder.click()
      await folder.press('ArrowRight')
      await expect(row('original.jpg')).toBeVisible()
      await folder.press('Control+v')
      await expect
        .poll(() => reads.evaluate((clipboard) => clipboard.bufferReads()))
        .toBeGreaterThan(0)
      const before = await reads.evaluate((clipboard) => clipboard.bufferReads())
      await folder.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /Paste Image/ }).click()
      await expect
        .poll(() => reads.evaluate((clipboard) => clipboard.bufferReads()))
        .toBeGreaterThan(before)
      expect(await reads.evaluate((clipboard) => clipboard.imageReads())).toBe(0)
      expect(await readdir(destination)).toEqual(['original.jpg'])
      expect(await readFile(originalPath)).toEqual(original)
      await expect(row('original.jpg')).toBeVisible()
      await expect(row('pasted-image.png')).toHaveCount(0)
      await testInfo.attach('file-reference-result.json', {
        body: JSON.stringify({
          source,
          gestures: 2,
          imageReads: 0,
          files: await readdir(destination)
        }),
        contentType: 'application/json'
      })
    } finally {
      await reads.evaluate((clipboard) => {
        clipboard.restore()
      })
      await reads.dispose()
    }
  })
}
