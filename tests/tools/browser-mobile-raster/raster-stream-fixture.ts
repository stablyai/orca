import { app, BrowserWindow, webContents, nativeImage } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OffscreenBrowserBackend } from '../../../src/main/browser/backends/offscreen-browser-backend'
import { startBrowserScreencast } from '../../../src/main/browser/cdp/screencast/browser-screencast-stream'
import { decodeBrowserScreencastFrame } from '../../../src/shared/browser/screencast/browser-screencast-protocol'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('background launch required')
}
app.setPath('userData', process.env.RASTER_USER_DATA!)
if (process.platform === 'darwin') {
  app.dock?.hide()
  app.setActivationPolicy('accessory')
}
const deadline = setTimeout(() => app.exit(2), 30000)
app
  .whenReady()
  .then(async () => {
    const backend = new OffscreenBrowserBackend({
      registerOffscreenGuest: () => true,
      unregisterGuest: () => {}
    } as never)
    const { browserPageId } = await backend.createTab({
      url: 'about:blank',
      worktreeId: 'raster-fixture'
    })
    const wc = webContents.fromId(backend.getWebContentsId(browserPageId)!)!
    await wc.loadURL(pathToFileURL(process.env.RASTER_FIXTURE!).href)
    const state = () => wc.executeJavaScript('window.__rasterProbe()')
    const initial = await state()
    const dpr = Number(process.env.RASTER_DPR ?? 2)
    const scenarios =
      dpr === 3
        ? ([
            ['portrait', 360, 534, 900, 1335, 900, 1335],
            ['reload', 360, 534, 900, 1335, 900, 1335],
            ['landscape', 534, 360, 1335, 900, 1335, 900],
            ['budget', 360, 534, 360, 534, 360, 534],
            ['fallback', 360, 534, 360, 534, 360, 534],
            ['click', 360, 534, 900, 1335, 900, 1335]
          ] as const)
        : ([
            ['portrait', 360, 534, 900, 1335, 720, 1068],
            ['reload', 360, 534, 900, 1335, 720, 1068],
            ['landscape', 534, 360, 1335, 900, 1068, 720],
            ['budget', 360, 534, 360, 534, 360, 534],
            ['fallback', 360, 534, 360, 534, 360, 534],
            ['click', 360, 534, 900, 1335, 720, 1068]
          ] as const)
    const results: unknown[] = []
    const failures: string[] = []
    for (const [
      name,
      width,
      height,
      maxWidth,
      maxHeight,
      expectedWidth,
      expectedHeight
    ] of scenarios) {
      const sizes: { width: number; height: number }[] = []
      const errors: string[] = []
      let firstImage: Buffer | null = null
      let changed = false
      const stream = await startBrowserScreencast(wc, {
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
        },
        onError: (message) => errors.push(message)
      })
      if (name === 'reload') {
        await wc.reload()
      }
      await new Promise((resolve) => setTimeout(resolve, 1400))
      const capture = wc.capturePage
      if (name === 'fallback') {
        await wc.debugger.sendCommand('Page.stopScreencast')
        wc.capturePage = () => Promise.reject(new Error('fixture capture unavailable'))
        await stream.updateViewport({
          viewportWidth: width,
          viewportHeight: height,
          deviceScaleFactor: dpr,
          mobile: true
        })
        wc.capturePage = capture
      }
      let click: unknown
      if (name === 'click') {
        const before = await state()
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
        let after = await state()
        for (let attempt = 0; after.clicks === before.clicks && attempt < 100; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          after = await state()
        }
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
      if (firstImage && process.env.RASTER_OUTPUT) {
        mkdirSync(process.env.RASTER_OUTPUT, { recursive: true })
        writeFileSync(join(process.env.RASTER_OUTPUT, `${name}.jpg`), firstImage)
      }
    }
    const report = {
      electron: process.versions.electron,
      hidden: BrowserWindow.getAllWindows().every((w) => !w.isVisible()),
      initial,
      results,
      failures
    }
    if (process.env.RASTER_OUTPUT) {
      writeFileSync(join(process.env.RASTER_OUTPUT, 'report.json'), JSON.stringify(report, null, 2))
    }
    console.log(JSON.stringify({ electron: report.electron, hidden: report.hidden, failures }))
    await backend.destroyAll()
    clearTimeout(deadline)
    app.exit(failures.length ? 1 : 0)
  })
  .catch((error) => {
    console.error(error)
    clearTimeout(deadline)
    app.exit(1)
  })
