// #10861/#18865: under a mouse-reporting TUI, an Option-drag selection must survive the wheel
// and right-button reports that follow it, so Cmd+C and right-click Copy still copy it.

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  execInTerminal,
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const TARGET = 'MOUSE_REPORT_COPY_TARGET'

type CellPoint = { x: number; y: number }

// Viewport-relative centers of the target's first and last cells.
async function locateTarget(page: Page): Promise<{ start: CellPoint; end: CellPoint }> {
  return page.evaluate((target) => {
    const state = window.__store!.getState()
    const pane = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!
    const buffer = pane.terminal.buffer.active
    let row = -1
    for (let y = buffer.length - 1; y >= 0; y--) {
      if (buffer.getLine(y)?.translateToString(true) === target) {
        row = y - buffer.viewportY
        break
      }
    }
    const screen = pane.terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
    const cellWidth = screen.width / pane.terminal.cols
    const cellHeight = screen.height / pane.terminal.rows
    const point = (col: number): CellPoint => ({
      x: screen.left + (col + 0.5) * cellWidth,
      y: screen.top + (row + 0.5) * cellHeight
    })
    return { start: point(0), end: point(target.length - 1) }
  }, TARGET)
}

function readSelection(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    return window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal.getSelection()
  })
}

async function optionDragSelectTarget(page: Page): Promise<CellPoint> {
  const { start, end } = await locateTarget(page)
  await page.keyboard.down('Alt')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x + 2, end.y, { steps: 5 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  return start
}

test.describe('terminal copy under mouse reporting', () => {
  test('Option-drag selection survives wheel and right-click reports and copies', async ({
    electronApp,
    orcaPage
  }) => {
    test.skip(process.platform !== 'darwin', 'macOptionClickForcesSelection is macOS-only')
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)

    const half = TARGET.length / 2
    await execInTerminal(
      orcaPage,
      ptyId,
      `clear; printf '%s%s\\n\\033[?1000h\\033[?1006h' '${TARGET.slice(0, half)}' '${TARGET.slice(half)}'; stty -echo; cat >/dev/null`
    )
    await waitForTerminalOutput(orcaPage, TARGET)
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const state = window.__store!.getState()
          return window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal.modes
            .mouseTrackingMode
        })
      )
      .toBe('vt200')

    const sentinel = 'CLIPBOARD_SENTINEL'
    const readClipboard = (): Promise<string> =>
      electronApp.evaluate(({ clipboard }) => clipboard.readText())
    const originalClipboard = await readClipboard()
    try {
      const start = await optionDragSelectTarget(orcaPage)
      expect(await readSelection(orcaPage)).toBe(TARGET)

      await orcaPage.mouse.wheel(0, 120)
      await orcaPage.mouse.wheel(0, -120)
      expect(await readSelection(orcaPage)).toBe(TARGET)

      await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), sentinel)
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.press('Meta+c')
      await expect.poll(readClipboard).toBe(TARGET)

      await electronApp.evaluate(({ clipboard }, text) => clipboard.writeText(text), sentinel)
      await orcaPage.mouse.click(start.x, start.y, { button: 'right' })
      await orcaPage.getByRole('menuitem').first().click()
      await expect.poll(readClipboard).toBe(TARGET)
    } finally {
      await electronApp.evaluate(
        ({ clipboard }, text) => clipboard.writeText(text),
        originalClipboard
      )
      await sendToTerminal(orcaPage, ptyId, '\x03')
      await execInTerminal(orcaPage, ptyId, "stty echo; printf '\\033[?1006l\\033[?1000l'")
    }
  })
})
