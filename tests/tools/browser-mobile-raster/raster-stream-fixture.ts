import { app, BrowserWindow, webContents, nativeImage } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OffscreenBrowserBackend } from '../../../src/main/browser/backends/offscreen-browser-backend'
import { startBrowserScreencast } from '../../../src/main/browser/cdp/screencast/browser-screencast-stream'
import { decodeBrowserScreencastFrame } from '../../../src/shared/browser/screencast/browser-screencast-protocol'

app.setPath('userData', process.env.RASTER_USER_DATA!)
if (process.platform === 'darwin') {
  app.dock?.hide()
  app.setActivationPolicy('accessory')
}
app
  .whenReady()
  .then(async () => {
    const registration = {
      registerOffscreenGuest: () => true,
      unregisterGuest: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture replaces only registration; windows and screencasts use real Electron.
    const backend = new OffscreenBrowserBackend(registration as never)
    const { browserPageId } = await backend.createTab({
      url: 'about:blank',
      worktreeId: 'raster-fixture'
    })
    const wc = webContents.fromId(backend.getWebContentsId(browserPageId)!)!
    await wc.loadURL(pathToFileURL(process.env.RASTER_FIXTURE!).href)
    const state = () => wc.executeJavaScript('window.__rasterProbe()')
    const initial = await state()
    const dpr = Number(process.env.RASTER_DPR)
    const scenarios = [
      ['portrait', 360, 534, 900, 1335, [720, 1068], [900, 1335]],
      ['reload', 360, 534, 900, 1335, [720, 1068], [900, 1335]],
      ['landscape', 534, 360, 1335, 900, [1068, 720], [1335, 900]],
      ['budget', 360, 534, 360, 534, [360, 534], [360, 534]],
      ['fallback', 360, 534, 360, 534, [360, 534], [360, 534]]
    ] as const
    const results: unknown[] = []
    const failures: string[] = []
    for (const [name, width, height, maxWidth, maxHeight, at2x, at3x] of scenarios) {
      const [expectedWidth, expectedHeight] = dpr === 3 ? at3x : at2x
      const sizes: { width: number; height: number }[] = []
      const errors: string[] = []
      let firstImage: Buffer | null = null
      let changed = false
      let onObserved!: () => void
      const waitForFrame = () =>
        new Promise<void>((resolve) => {
          onObserved = resolve
        })
      let observed = waitForFrame()
      const stream = await startBrowserScreencast(wc, {
        holdPaint: () => () => {},
        format: 'jpeg',
        quality: 72,
        maxWidth,
        maxHeight,
        viewportWidth: width,
        viewportHeight: height,
        deviceScaleFactor: dpr,
        mobile: true,
        everyNthFrame: 1,
        minFrameIntervalMs: 100,
        onFrame(bytes) {
          const frame = decodeBrowserScreencastFrame(bytes)!
          const buffer = Buffer.from(frame.image)
          sizes.push(nativeImage.createFromBuffer(buffer).getSize())
          changed ||= firstImage !== null && !firstImage.equals(buffer)
          firstImage ??= buffer
          if (changed) {
            onObserved()
          }
        },
        onError: (message) => errors.push(message)
      })
      if (name === 'reload') {
        sizes.length = 0
        firstImage = null
        changed = false
        observed = waitForFrame()
        const loaded = new Promise<void>((resolve) => wc.once('did-finish-load', () => resolve()))
        wc.reload()
        await loaded
      }
      await observed
      const capture = wc.capturePage
      if (name === 'fallback') {
        await wc.debugger.sendCommand('Page.stopScreencast')
        sizes.length = 0
        firstImage = null
        observed = waitForFrame()
        wc.capturePage = () => Promise.reject(new Error('fixture capture unavailable'))
        await stream.updateViewport({
          viewportWidth: width,
          viewportHeight: height,
          deviceScaleFactor: dpr,
          mobile: true
        })
        await observed
        wc.capturePage = capture
      }
      let click: unknown
      if (name === 'portrait') {
        const before = await state()
        await wc.executeJavaScript(
          'window.__rasterClicked = new Promise(resolve => document.querySelector("#button").addEventListener("click", resolve, {once: true})); true'
        )
        wc.sendInputEvent({
          type: 'mouseDown',
          x: Math.round(before.button.x),
          y: Math.round(before.button.y),
          button: 'left',
          clickCount: 1
        })
        wc.sendInputEvent({
          type: 'mouseUp',
          x: Math.round(before.button.x),
          y: Math.round(before.button.y),
          button: 'left',
          clickCount: 1
        })
        await wc.executeJavaScript('window.__rasterClicked.then(() => true)')
        const after = await state()
        click = { before: before.clicks, after: after.clicks, trusted: after.trusted }
        if (after.clicks !== before.clicks + 1 || !after.trusted) {
          failures.push(`${name}: click`)
        }
      }
      const dom = await state()
      stream.stop()
      await stream.done
      const restored = await state()
      const dimensions = [...new Set(sizes.map((size) => `${size.width}x${size.height}`))]
      if (!changed) {
        failures.push(`${name}: no changing image content`)
      }
      if (
        !sizes.length ||
        sizes.some((size) => size.width !== expectedWidth || size.height !== expectedHeight)
      ) {
        failures.push(
          `${name}: expected ${expectedWidth}x${expectedHeight}, got ${dimensions.join(',')}`
        )
      }
      if (dom.width !== width || dom.height !== height) {
        failures.push(`${name}: logical viewport`)
      }
      if (
        restored.width !== initial.width ||
        restored.height !== initial.height ||
        restored.dpr !== initial.dpr
      ) {
        failures.push(`${name}: restoration`)
      }
      if (errors.length) {
        failures.push(`${name}: ${errors.join(',')}`)
      }
      const result = { name, frames: sizes.length, dimensions, dom, restored, click, errors }
      results.push(result)
      console.log(JSON.stringify(result))
      writeFileSync(join(process.env.RASTER_OUTPUT!, `${name}.jpg`), firstImage!)
    }
    const report = {
      electron: process.versions.electron,
      hidden: BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      initial,
      results,
      failures
    }
    writeFileSync(join(process.env.RASTER_OUTPUT!, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ electron: report.electron, hidden: report.hidden, failures }))
    await backend.destroyAll()
    app.exit(failures.length ? 1 : 0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
