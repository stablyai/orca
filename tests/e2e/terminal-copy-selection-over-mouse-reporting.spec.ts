import { randomUUID } from 'node:crypto'
import { test, expect } from './helpers/orca-app'
import { pressShortcut } from './helpers/shortcuts'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  resolveActiveTabId,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'

// Why these DECSET modes: they are exactly what Codex's TUI switches on (button,
// drag, any-motion, SGR), which hands every plain drag to the app instead of xterm.
function mouseReportingScript(marker: string): string {
  return `
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h')
process.stdout.write(${JSON.stringify(marker)} + '\\n')
process.stdin.on('data', (chunk) => {
  if (chunk.includes(String.fromCharCode(3))) {
    process.stdout.write('\\x1b[?1006l\\x1b[?1003l\\x1b[?1002l\\x1b[?1000l')
    process.exit(0)
  }
})
`
}

type MarkerGeometry = { x1: number; x2: number; y: number; mouseTrackingMode: string }

async function locateMarker(page: Page, tabId: string, marker: string): Promise<MarkerGeometry> {
  return page.evaluate(
    ({ tabId, marker }) => {
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
      if (!pane) {
        throw new Error('No active terminal pane')
      }
      const { terminal } = pane
      const buffer = terminal.buffer.active
      const screen = pane.container.querySelector<HTMLElement>('.xterm-screen')
      const rect = screen?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        throw new Error('Terminal surface is not measurable')
      }
      const cellWidth = rect.width / terminal.cols
      const cellHeight = rect.height / terminal.rows
      for (let row = buffer.length - 1; row >= 0; row -= 1) {
        const text = buffer.getLine(row)?.translateToString(true) ?? ''
        const col = text.indexOf(marker)
        if (col === -1) {
          continue
        }
        const viewportRow = row - buffer.viewportY
        return {
          x1: rect.left + (col + 0.3) * cellWidth,
          x2: rect.left + (col + marker.length - 0.3) * cellWidth,
          y: rect.top + (viewportRow + 0.5) * cellHeight,
          mouseTrackingMode: terminal.modes.mouseTrackingMode
        }
      }
      throw new Error(`Marker ${marker} is not on screen`)
    },
    { tabId, marker }
  )
}

async function dragAcross(page: Page, geometry: MarkerGeometry): Promise<void> {
  await page.mouse.move(geometry.x1, geometry.y)
  await page.mouse.down()
  await page.mouse.move((geometry.x1 + geometry.x2) / 2, geometry.y, { steps: 4 })
  await page.mouse.move(geometry.x2, geometry.y, { steps: 4 })
  await page.mouse.up()
}

async function readActiveSelection(page: Page, tabId: string): Promise<string> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
    return pane?.terminal.getSelection() ?? ''
  }, tabId)
}

test.describe('terminal copy over a mouse-reporting TUI', () => {
  test('a plain drag hands the mouse to the app, so Cmd/Ctrl+C explains itself; the setting hands the drag back to xterm', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const tabId = await resolveActiveTabId(orcaPage)
    expect(tabId).toBeTruthy()
    const marker = `COPY_TARGET_${randomUUID().slice(0, 8)}`
    const staged = await runNodeScriptInTerminal(orcaPage, ptyId, mouseReportingScript(marker))
    try {
      await waitForTerminalOutput(orcaPage, marker, 15_000)
      await expect
        .poll(async () => (await locateMarker(orcaPage, tabId!, marker)).mouseTrackingMode)
        .not.toBe('none')

      // Default: the app owns the drag, exactly like Codex, so xterm has no selection.
      await dragAcross(orcaPage, await locateMarker(orcaPage, tabId!, marker))
      expect(await readActiveSelection(orcaPage, tabId!)).toBe('')

      const sentinel = `sentinel-${randomUUID()}`
      await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), sentinel)
      await pressShortcut(orcaPage, 'C')
      await expect(orcaPage.getByText('Nothing selected to copy')).toBeVisible()
      expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(sentinel)

      // Opting in flips the running pane live: the same drag now selects in xterm.
      await orcaPage.evaluate(() =>
        window.__store?.getState().updateSettings({ terminalSelectionOverMouseReporting: true })
      )
      await expect
        .poll(() =>
          orcaPage.evaluate((tabId) => {
            const manager = window.__paneManagers?.get(tabId)
            const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
            return pane?.terminal.options.mouseEventsRequireAlt === true
          }, tabId!)
        )
        .toBe(true)
      await dragAcross(orcaPage, await locateMarker(orcaPage, tabId!, marker))
      expect(await readActiveSelection(orcaPage, tabId!)).toContain(marker)

      await pressShortcut(orcaPage, 'C')
      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
        .toContain(marker)
    } finally {
      await sendToTerminal(orcaPage, ptyId, '\u0003').catch(() => undefined)
      staged.cleanup()
    }
  })
})
