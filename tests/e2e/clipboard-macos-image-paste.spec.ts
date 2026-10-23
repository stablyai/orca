import { readFile, rm } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('macOS JPEG clipboard bytes produce a PNG and a matching preview', async ({
  electronApp,
  orcaPage
}) => {
  test.skip(process.platform !== 'darwin', 'macOS native clipboard contract')
  await waitForSessionReady(orcaPage)
  // Reproduce the measured CleanShot API results without changing the user's clipboard.
  await electronApp.evaluate(({ clipboard, ClipboardItem, nativeImage }) => {
    const image = nativeImage.createFromBitmap(Buffer.alloc(16 * 12 * 4, 200), {
      width: 16,
      height: 12
    })
    const jpeg = image.toJPEG(80)
    const type = 'electron application/osclipboard;format="public.png"'
    clipboard.read = async () => [new ClipboardItem({ [type]: new Blob([new Uint8Array(jpeg)]) })]
    clipboard.has = async (format) => format === type
  })

  let savedPath: string | null = null
  try {
    expect(await orcaPage.evaluate(() => window.api.ui.clipboardHasImage())).toBe(true)
    savedPath = await orcaPage.evaluate(() => window.api.ui.saveClipboardImageAsTempFile())
    expect(savedPath).toMatch(/orca-paste-.+\.png$/)
    if (!savedPath) {
      throw new Error('Clipboard image was not saved')
    }
    const png = await readFile(savedPath)
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([16, 12])

    const thumbnail = await orcaPage.evaluate(() => window.api.ui.readClipboardImageThumbnail())
    expect(thumbnail).toMatchObject({ width: 16, height: 12 })
    expect(thumbnail?.dataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)

    await electronApp.evaluate(({ clipboard, ClipboardItem }) => {
      clipboard.read = async () => [
        new ClipboardItem({
          'electron application/osclipboard;format="public.png"': 'malformed image'
        })
      ]
    })
    expect(await orcaPage.evaluate(() => window.api.ui.saveClipboardImageAsTempFile())).toBeNull()
    expect(await orcaPage.evaluate(() => window.api.ui.readClipboardImageThumbnail())).toBeNull()

    // A copied image file alone remains outside the clipboard-image save path.
    await electronApp.evaluate(({ clipboard, ClipboardItem }) => {
      clipboard.has = async () => false
      clipboard.read = async () => [new ClipboardItem({ 'text/uri-list': 'file:///tmp/shot.png' })]
    })
    expect(await orcaPage.evaluate(() => window.api.ui.clipboardHasImage())).toBe(false)
    expect(await orcaPage.evaluate(() => window.api.ui.saveClipboardImageAsTempFile())).toBeNull()
  } finally {
    if (savedPath) {
      await rm(savedPath, { force: true })
    }
  }
})
