import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { prepareImagePasteFolder } from './helpers/explorer-image-paste'
import { captureSystemImageClipboard } from './helpers/system-image-clipboard'
import { evaluateHiddenBrowserPage } from './helpers/hidden-browser-page'

test('Windows Edge image document copies real pixels into the explorer', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  test.skip(
    process.platform !== 'win32' || process.env.ORCA_E2E_BROWSER_CLIPBOARD_IMAGE !== '1',
    'Requires installed Edge and explicit browser clipboard opt-in; run with --workers=1.'
  )
  expect(testInfo.config.workers).toBe(1)
  const { destination, row, folder } = await prepareImagePasteFolder(page, 'edge-image')
  const source = await electronApp.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(
        Buffer.from([0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 0, 255]),
        {
          width: 2,
          height: 2
        }
      )
      .toPNG()
      .toString('base64')
  )
  // Chromium requires an existing target before creating a hidden page.
  const bootstrapPath = testInfo.outputPath('browser-bootstrap')
  await mkdir(bootstrapPath)
  await writeFile(
    path.join(bootstrapPath, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Clipboard test bootstrap',
      version: '1.0',
      background: { service_worker: 'worker.js' }
    })
  )
  await writeFile(
    path.join(bootstrapPath, 'worker.js'),
    'chrome.runtime.onInstalled.addListener(() => {});'
  )
  // Headless Chromium replaces the OS clipboard; hidden targets keep native clipboard access.
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-startup-window', '--enable-unsafe-extension-debugging']
  })
  const cdp = await browser.newBrowserCDPSession()
  try {
    const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: bootstrapPath })
    await expect
      .poll(async () =>
        (await cdp.send('Target.getTargets')).targetInfos.some(
          (target) =>
            target.type === 'service_worker' &&
            target.url === `chrome-extension://${extensionId}/worker.js`
        )
      )
      .toBe(true)
    const { targetId } = await cdp.send('Target.createTarget', {
      url: `data:image/png;base64,${source}`,
      hidden: true,
      background: true
    })
    await expect(cdp.send('Browser.getWindowForTarget', { targetId })).rejects.toThrow(
      'Browser window not found'
    )
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false })
    await expect(() =>
      evaluateHiddenBrowserPage(cdp, sessionId, 'document.querySelector("img").decode()')
    ).toPass({ timeout: 10_000 })
    const lease = await captureSystemImageClipboard(electronApp)
    try {
      await lease.evaluate((clipboard) => clipboard.assertUnchanged())
      await evaluateHiddenBrowserPage(
        cdp,
        sessionId,
        'if (!document.execCommand("copy")) throw new Error("Browser copy command failed")'
      )
      await expect
        .poll(() =>
          electronApp.evaluate(({ clipboard }) => ({
            formats: clipboard.availableFormats(),
            size: clipboard.readImage().getSize()
          }))
        )
        .toMatchObject({ size: { width: 2, height: 2 } })
      const snapshot = await lease.evaluate(
        (clipboard, expected) => clipboard.adoptExternalImage(expected),
        source
      )
      expect(snapshot.formats).toContain('image/png')
      await folder.click()
      await folder.press('Control+v')
      await expect(row('pasted-image.png')).toHaveAttribute('data-selected', 'true')
      const saved = await readFile(path.join(destination, 'pasted-image.png'))
      const pixels = await electronApp.evaluate(
        ({ nativeImage }, args) => {
          const original = nativeImage.createFromBuffer(Buffer.from(args.source, 'base64'))
          const imported = nativeImage.createFromBuffer(Buffer.from(args.saved, 'base64'))
          return {
            sourceSize: original.getSize(),
            savedSize: imported.getSize(),
            equal: !imported.isEmpty() && original.toBitmap().equals(imported.toBitmap())
          }
        },
        { source, saved: saved.toString('base64') }
      )
      expect(pixels.sourceSize).toEqual({ width: 2, height: 2 })
      expect(pixels.savedSize).toEqual(pixels.sourceSize)
      expect(pixels.equal).toBe(true)
      expect(await readdir(destination)).toEqual(['pasted-image.png'])
      await page.screenshot({ path: testInfo.outputPath('browser-clipboard-explorer.png') })
      await testInfo.attach('pasted-image.png', { body: saved, contentType: 'image/png' })
      await testInfo.attach('browser-clipboard.json', {
        body: JSON.stringify(
          {
            browser: 'Microsoft Edge',
            version: browser.version(),
            gesture: 'Browser copy command on an image document via CDP',
            hiddenTarget: true,
            browserWindow: false,
            formats: snapshot.formats,
            text: snapshot.text,
            html: snapshot.html,
            pixels,
            sha256: createHash('sha256').update(saved).digest('hex')
          },
          null,
          2
        ),
        contentType: 'application/json'
      })
    } finally {
      const restored = await lease.evaluate((clipboard) => clipboard.restore())
      testInfo.annotations.push({ type: 'clipboard-restored', description: String(restored) })
      await lease.dispose()
    }
  } finally {
    try {
      await cdp.detach()
    } finally {
      await browser.close()
    }
  }
})
