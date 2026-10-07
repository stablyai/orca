import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getTerminalContent, sendToTerminal } from './helpers/terminal'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { setImeComposition } from './terminal-ime-cdp-composition'
import { writeToActiveTerminal } from './terminal-ime-midline-occlusion-probe'

// Recorded at 100 columns; a narrower pane would rewrap the box and move the caret.
const TRANSCRIPT = readFileSync(
  path.join(__dirname, '../../src/main/runtime/__fixtures__/cursor-agent-ime-korean-typed.txt'),
  'utf8'
)
const TYPED_INPUT = '→ 안녕 하세요a한b'

type CellGeometry = {
  caret: { row: number; column: number }
  textarea: { row: number; column: number }
  preedit: { row: number; column: number }
  cellHeight: number
}

/** The caret cell is read from screen text ("b" after Left/Right), not from the anchor's rule. */
function readCellGeometry(page: Page, typedInput: string): Promise<CellGeometry> {
  return page.evaluate((input: string) => {
    const state = window.__store!.getState()
    const pane = window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!
    const { terminal } = pane
    const buffer = terminal.buffer.active
    let caret: { row: number; column: number } | null = null
    for (let row = 0; row < terminal.rows && !caret; row++) {
      const line = buffer.getLine(buffer.baseY + row)
      if (!line?.translateToString(true).trimStart().startsWith(input)) {
        continue
      }
      for (let column = terminal.cols - 1; column >= 0; column--) {
        if (line.getCell(column)?.getChars() === input.at(-1)) {
          caret = { row, column }
          break
        }
      }
    }
    if (!caret) {
      throw new Error('Replayed cursor-agent input row is not on screen')
    }
    const screen = terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
    const cellWidth = screen.width / terminal.cols
    const cellHeight = screen.height / terminal.rows
    const cellOf = (element: Element): { row: number; column: number } => {
      const rect = element.getBoundingClientRect()
      return {
        row: Math.round((rect.top - screen.top) / cellHeight),
        column: Math.round((rect.left - screen.left) / cellWidth)
      }
    }
    return {
      caret,
      textarea: cellOf(terminal.textarea!),
      preedit: cellOf(terminal.element!.querySelector('.composition-view.active')!),
      cellHeight
    }
  }, typedInput)
}

test('opens the Korean preedit on a hidden-cursor TUI’s drawn caret, not its parked cursor', async ({
  orcaPage
}, testInfo) => {
  test.skip(process.platform === 'win32', 'the sink for the replay’s terminal replies is POSIX cat')
  const arena = await openTerminalImePaneArena(orcaPage)
  let completed = false
  try {
    const cols = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      return window.__paneManagers!.get(state.activeTabId!)!.getActivePane()!.terminal.cols
    })
    test.skip(cols < 100, `pane has ${cols} columns; the transcript needs 100`)
    // Why: the recording's queries and focus reports make xterm answer on the pty; a silent sink
    // keeps the shell from echoing those answers over the replayed screen.
    await sendToTerminal(orcaPage, arena.ptyId, 'stty -echo; exec cat >/dev/null\r')
    await expect.poll(() => getTerminalContent(orcaPage)).toContain('exec cat')
    await orcaPage.waitForTimeout(200)
    // Earlier shell output above the agent, as when it is launched from a used shell.
    await writeToActiveTerminal(
      orcaPage,
      `\x1b[2J\x1b[H$ ls\r\n${'notes.txt\r\n'.repeat(4)}$ cursor-agent\r\n${TRANSCRIPT}`
    )

    await setImeComposition(arena.session, '세')
    await expect(orcaPage.locator('.composition-view.active')).toContainText('세')
    await orcaPage.waitForTimeout(50)
    const geometry = await readCellGeometry(orcaPage, TYPED_INPUT)
    const screen = await orcaPage
      .locator('.xterm:has(.xterm-helper-textarea:focus) .xterm-screen')
      .boundingBox()
    // The top 22 rows hold the whole replay; the rest of the pane is empty.
    await orcaPage.screenshot({
      path: testInfo.outputPath('cursor-agent-ime-anchor.png'),
      clip: {
        x: screen!.x,
        y: screen!.y,
        width: screen!.width * 0.75,
        height: geometry.cellHeight * 22
      }
    })

    expect(geometry.textarea).toEqual(geometry.caret)
    expect(geometry.preedit).toEqual(geometry.caret)
    await setImeComposition(arena.session, '')
    completed = true
  } finally {
    await closeTerminalImePaneArena(arena, testInfo, 'app-drawn-caret-anchor', !completed)
  }
})
