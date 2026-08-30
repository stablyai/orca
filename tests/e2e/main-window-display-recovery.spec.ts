import { execFileSync } from 'node:child_process'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

type NativeWindowBounds = { position: [number, number]; size: [number, number] }
type DisplayWorkArea = { x: number; y: number; width: number; height: number }

function readNativeWindowBounds(processId: number): NativeWindowBounds {
  const output = execFileSync(
    '/usr/bin/osascript',
    [
      '-e',
      'tell application "System Events"',
      '-e',
      `set matches to every application process whose unix id is ${processId}`,
      '-e',
      'if (count of matches) is not 1 then error "expected one application process"',
      '-e',
      'tell item 1 of matches',
      '-e',
      'if (count of windows) is not 1 then error "expected one native window"',
      '-e',
      'set windowPosition to position of window 1',
      '-e',
      'set windowSize to size of window 1',
      '-e',
      'return {item 1 of windowPosition, item 2 of windowPosition, item 1 of windowSize, item 2 of windowSize}',
      '-e',
      'end tell',
      '-e',
      'end tell'
    ],
    { encoding: 'utf8' }
  )
  const [x, y, width, height] = output.split(',').map((value) => Number(value.trim()))
  return { position: [x, y], size: [width, height] }
}

test.describe('Main window display recovery', () => {
  test.skip(process.platform !== 'darwin', 'Accessibility report is macOS-specific')

  test('display metrics recover an offscreen live main window @headful', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)

    const result = await electronApp.evaluate(({ BrowserWindow, screen }) => {
      const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
      if (windows.length !== 1) {
        throw new Error(`expected one BrowserWindow, found ${windows.length}`)
      }
      const window = windows[0]
      if (window.isMaximized()) {
        window.unmaximize()
      }
      if (window.isFullScreen()) {
        throw new Error('expected a normal test window, found fullscreen')
      }
      const displays = screen.getAllDisplays()
      const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
      const bottom = Math.max(
        ...displays.map((display) => display.bounds.y + display.bounds.height)
      )
      const offscreenBounds = { x: right + 1000, y: bottom + 1000, width: 900, height: 700 }
      window.setBounds(offscreenBounds)
      const candidateBounds = window.getBounds()
      const candidateHasReachableTitlebar = displays.some(({ workArea: area }) => {
        const visibleWidth = Math.max(
          0,
          Math.min(candidateBounds.x + candidateBounds.width, area.x + area.width) -
            Math.max(candidateBounds.x, area.x)
        )
        const visibleTitlebarHeight = Math.max(
          0,
          Math.min(candidateBounds.y + 36, area.y + area.height) -
            Math.max(candidateBounds.y, area.y)
        )
        return visibleWidth >= 60 && visibleTitlebarHeight >= 16
      })
      if (candidateHasReachableTitlebar) {
        throw new Error(
          `expected unreachable candidate bounds, got ${JSON.stringify(candidateBounds)}`
        )
      }
      screen.emit('display-metrics-changed', {} as Electron.Event, screen.getPrimaryDisplay(), [
        'workArea'
      ])

      return {
        processId: process.pid,
        windowIdBefore: window.id,
        visible: window.isVisible(),
        displayWorkAreas: displays.map(({ workArea }) => workArea as DisplayWorkArea)
      }
    })

    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow, screen }) => {
          const window = BrowserWindow.getAllWindows()[0]
          const bounds = window.getBounds()
          const reachable = screen
            .getAllDisplays()
            .some(({ workArea: area }) =>
              Boolean(
                bounds.x >= area.x &&
                bounds.y >= area.y &&
                bounds.x + bounds.width <= area.x + area.width &&
                bounds.y + bounds.height <= area.y + area.height
              )
            )
          return { bounds, reachable, windowIdAfter: window.id }
        })
      )
      .toMatchObject({ reachable: true, windowIdAfter: result.windowIdBefore })
    expect(result.visible).toBe(true)
    expect(result.processId).toBe(electronApp.process().pid)

    await expect
      .poll(() => {
        try {
          const native = readNativeWindowBounds(result.processId)
          const [x, y] = native.position
          const [width, height] = native.size
          return result.displayWorkAreas.some((area) => {
            const overlapWidth = Math.max(
              0,
              Math.min(x + width, area.x + area.width) - Math.max(x, area.x)
            )
            const overlapHeight = Math.max(
              0,
              Math.min(y + height, area.y + area.height) - Math.max(y, area.y)
            )
            return overlapWidth > 0 && overlapHeight > 0
          })
        } catch {
          return false
        }
      })
      .toBe(true)
    expect(await orcaPage.locator('body').isVisible()).toBe(true)
    await orcaPage.screenshot({ path: testInfo.outputPath('main-window-display-recovered.png') })
  })
})
