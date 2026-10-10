import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  enableNativeTerminal,
  isNativeSurfaceHidden,
  nativeGridSize,
  nativeScreenText,
  settledNativeGrid,
  splitNativeTerminalPane,
  xtermScreenTransform
} from './helpers/native-terminal-debug'
import {
  execInTerminal,
  focusActiveTerminalInput,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const RENDER_COUNT_KEY = '__orcaE2eXtermRenderCount'

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'the native Ghostty terminal is macOS only')

async function prepare(page: Page, app: ElectronApplication): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  // Why: the hidden test window would otherwise pause rAF, so xterm could never paint at all.
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
    }
  })
  await enableNativeTerminal(page)
}

function countXtermRenders(page: Page, ptyId: string): Promise<void> {
  return page.evaluate(
    ({ id, key }) => {
      for (const manager of window.__paneManagers?.values() ?? []) {
        const pane = manager
          .getPanes()
          .find((candidate) => candidate.container.dataset.ptyId === id)
        if (pane) {
          Reflect.set(globalThis, key, 0)
          pane.terminal.onRender(() => {
            Reflect.set(globalThis, key, Number(Reflect.get(globalThis, key)) + 1)
          })
          return
        }
      }
      throw new Error(`no pane for PTY ${id}`)
    },
    { id: ptyId, key: RENDER_COUNT_KEY }
  )
}

function xtermRenderCount(page: Page): Promise<number> {
  return page.evaluate((key) => Number(Reflect.get(globalThis, key)), RENDER_COUNT_KEY)
}

function paneTextareaHasFocus(page: Page, ptyId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const active = document.activeElement
    return (
      active instanceof HTMLTextAreaElement &&
      active.classList.contains('xterm-helper-textarea') &&
      active.closest(`.pane[data-pty-id="${id}"]`) !== null
    )
  }, ptyId)
}

function paneFontSize(page: Page, ptyId: string): Promise<number | null> {
  return page.evaluate((id) => {
    for (const manager of window.__paneManagers?.values() ?? []) {
      const pane = manager.getPanes().find((candidate) => candidate.container.dataset.ptyId === id)
      if (pane) {
        return pane.terminal.options.fontSize ?? null
      }
    }
    return null
  }, ptyId)
}

function sendTerminalZoom(
  app: ElectronApplication,
  direction: 'in' | 'out' | 'reset'
): Promise<void> {
  return app.evaluate(({ BrowserWindow }, value) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('terminal:zoom', value)
    }
  }, direction)
}

test('xterm stops painting under a shown native view and repaints before an overlay hides it', async ({
  orcaPage,
  electronApp
}) => {
  await prepare(orcaPage, electronApp)
  const { ptyId, surfaceId } = await splitNativeTerminalPane(orcaPage, electronApp)
  await focusActiveTerminalInput(orcaPage)
  await expect.poll(async () => xtermScreenTransform(orcaPage, ptyId)).not.toBe('')
  await countXtermRenders(orcaPage, ptyId)

  // The parser keeps running while paused: xterm's buffer and the native screen both get it.
  await execInTerminal(orcaPage, ptyId, "seq 1 20000; printf 'PAUSE-%s\\n' DONE")
  await waitForTerminalOutput(orcaPage, 'PAUSE-DONE')
  await expect
    .poll(async () => nativeScreenText(electronApp, surfaceId), { timeout: 10_000 })
    .toContain('PAUSE-DONE')
  expect(await xtermRenderCount(orcaPage)).toBe(0)
  // Paste/copy ownership: the pane's helper textarea keeps DOM focus while its screen is paused.
  expect(await paneTextareaHasFocus(orcaPage, ptyId)).toBe(true)

  // An overlay hides the native view only once xterm has painted the current screen.
  await orcaPage.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.id = 'native-terminal-e2e-pause-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'
    document.body.appendChild(overlay)
  })
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(true)
  expect(await xtermRenderCount(orcaPage)).toBeGreaterThan(0)
  expect(await xtermScreenTransform(orcaPage, ptyId)).toBe('')

  await orcaPage.evaluate(() =>
    document.getElementById('native-terminal-e2e-pause-overlay')?.remove()
  )
  await expect.poll(async () => isNativeSurfaceHidden(electronApp, surfaceId)).toBe(false)
  await expect.poll(async () => xtermScreenTransform(orcaPage, ptyId)).not.toBe('')
  expect(await paneTextareaHasFocus(orcaPage, ptyId)).toBe(true)
})

test('per-pane font zoom resizes only that pane’s native grid', async ({
  orcaPage,
  electronApp
}) => {
  await prepare(orcaPage, electronApp)
  const other = await splitNativeTerminalPane(orcaPage, electronApp)
  const zoomed = await splitNativeTerminalPane(orcaPage, electronApp)
  const otherBefore = await settledNativeGrid(electronApp, other.surfaceId)
  const zoomedBefore = await settledNativeGrid(electronApp, zoomed.surfaceId)
  const baseSize = await paneFontSize(orcaPage, zoomed.ptyId)
  expect(baseSize).not.toBeNull()

  // Zoom targets the pane whose helper textarea has DOM focus (the active one).
  await focusActiveTerminalInput(orcaPage)
  for (let step = 0; step < 4; step += 1) {
    await sendTerminalZoom(electronApp, 'in')
  }
  await expect.poll(async () => paneFontSize(orcaPage, zoomed.ptyId)).toBe((baseSize ?? 0) + 4)
  await expect
    .poll(async () => (await nativeGridSize(electronApp, zoomed.surfaceId))?.columns ?? 0)
    .toBeLessThan(zoomedBefore.columns)
  // The xterm model (and so the PTY) follows the zoomed native grid.
  const zoomedGrid = await settledNativeGrid(electronApp, zoomed.surfaceId)
  await expect
    .poll(async () =>
      orcaPage.evaluate(() => {
        const tabId = window.__store?.getState().activeTabId
        const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
        return pane ? `${pane.terminal.cols}x${pane.terminal.rows}` : null
      })
    )
    .toBe(`${zoomedGrid.columns}x${zoomedGrid.rows}`)
  expect(await nativeGridSize(electronApp, other.surfaceId)).toEqual(otherBefore)

  await sendTerminalZoom(electronApp, 'reset')
  await expect
    .poll(async () => (await nativeGridSize(electronApp, zoomed.surfaceId))?.columns ?? 0)
    .toBe(zoomedBefore.columns)
})
