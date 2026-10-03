// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'
import { installTerminalImeCandidateAnchor } from './terminal-ime-candidate-anchor'

// Recorded with config/scripts/capture-agent-pty-transcript.mjs at 100x30; see each .meta.json.
const FIXTURES = join(__dirname, '../../../../main/runtime/__fixtures__')
const COLS = 100
const ROWS = 30
const CELL_WIDTH = 8
const CELL_HEIGHT = 17
// cursor-agent erases its box upward and repaints it once per key it handles.
// eslint-disable-next-line no-control-regex -- matching the recorded escape bytes is the point.
const CURSOR_AGENT_FRAME_START = /(?<!\x1b\[1A)(?=(?:\x1b\[2K\x1b\[1A)+\x1b\[2K\x1b\[G)/

type Cell = { row: number; column: number }

type TranscriptPane = {
  headless: HeadlessTerminal
  write: (data: string) => Promise<void>
  compose: () => Promise<void>
  textareaCell: () => Cell
  compositionViewCell: () => Cell | null
}

function readTranscript(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.txt`), 'utf8')
}

/** xterm's public surface the anchor reads, backed by a real parser fed the recorded bytes. */
function createTranscriptPane(): TranscriptPane {
  const headless = new HeadlessTerminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  const element = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.getBoundingClientRect = (): DOMRect =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the anchor reads only width and height.
    ({ width: COLS * CELL_WIDTH, height: ROWS * CELL_HEIGHT }) as DOMRect
  const compositionView = document.createElement('div')
  compositionView.className = 'composition-view'
  screen.appendChild(compositionView)
  element.appendChild(screen)
  const textarea = document.createElement('textarea')
  element.appendChild(textarea)
  document.body.appendChild(element)

  const terminal = {
    element,
    textarea,
    get cols() {
      return headless.cols
    },
    get rows() {
      return headless.rows
    },
    get modes() {
      return headless.modes
    },
    get buffer() {
      return headless.buffer
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the anchor reads only element, textarea, size, modes and the active buffer.
  installTerminalImeCandidateAnchor(terminal as unknown as Terminal)

  const cellOf = (style: CSSStyleDeclaration): Cell => ({
    row: Number.parseFloat(style.top) / CELL_HEIGHT,
    column: Number.parseFloat(style.left) / CELL_WIDTH
  })
  return {
    headless,
    write: (data) => new Promise((resolve) => headless.write(data, resolve)),
    // Real timers: the parser batches writes on one, and the anchor's deferred re-apply is queued
    // ahead of the one awaited here.
    compose: async () => {
      element.dispatchEvent(new Event('compositionstart'))
      element.dispatchEvent(new Event('compositionupdate'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    textareaCell: () => cellOf(textarea.style),
    compositionViewCell: () => (compositionView.style.top ? cellOf(compositionView.style) : null)
  }
}

function charAt(headless: HeadlessTerminal, cell: Cell): string {
  const buffer = headless.buffer.active
  return (
    buffer
      .getLine(buffer.baseY + cell.row)
      ?.getCell(cell.column)
      ?.getChars() ?? ''
  )
}

describe('IME anchor on replayed agent transcripts', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('moves the candidate window and preedit onto cursor-agent’s caret, off the parked cursor', async () => {
    const pane = createTranscriptPane()
    await pane.write(readTranscript('cursor-agent-ime-ready'))
    const buffer = pane.headless.buffer.active
    expect({ row: buffer.cursorY, column: buffer.cursorX }).toEqual({ row: 14, column: 0 })

    await pane.compose()

    expect(pane.textareaCell()).toEqual({ row: 9, column: 4 })
    expect(pane.compositionViewCell()).toEqual({ row: 9, column: 4 })
    expect(charAt(pane.headless, { row: 9, column: 4 })).toBe('P')
  })

  it('follows cursor-agent’s caret through each repaint of Korean, Backspace and Left/Right', async () => {
    const pane = createTranscriptPane()
    const anchors: number[] = []
    for (const frame of readTranscript('cursor-agent-ime-korean-typed').split(
      CURSOR_AGENT_FRAME_START
    )) {
      await pane.write(frame)
      await pane.compose()
      expect(pane.textareaCell().row).toBe(9)
      expect(pane.compositionViewCell()).toEqual(pane.textareaCell())
      anchors.push(pane.textareaCell().column)
    }

    // Ready, 안, 녕 and a space, 하, 세, 요, abc, Backspace, Left, Left, Right, 한 — the last lands on "b".
    expect(anchors).toEqual([4, 6, 9, 11, 13, 15, 18, 17, 16, 15, 16, 18])
    expect(charAt(pane.headless, { row: 9, column: 18 })).toBe('b')
  })

  it('finds the caret when cursor-agent starts below earlier shell output', async () => {
    const pane = createTranscriptPane()
    await pane.write(`$ ls\r\n${'file.txt\r\n'.repeat(9)}`)
    await pane.write(readTranscript('cursor-agent-ime-korean-typed'))

    await pane.compose()

    expect(pane.textareaCell()).toEqual({ row: 19, column: 18 })
    expect(pane.compositionViewCell()).toEqual({ row: 19, column: 18 })
  })

  it.each([
    ['claude-code-ime-korean-typed', { row: 26, column: 16 }],
    ['codex-ime-korean-typed', { row: 10, column: 16 }],
    ['grok-ime-korean-typed', { row: 25, column: 20 }]
  ])('keeps %s on its shown cursor and leaves the preedit to xterm', async (name, cursor) => {
    const pane = createTranscriptPane()
    await pane.write(readTranscript(name))

    await pane.compose()

    expect(pane.headless.modes.showCursor).toBe(true)
    expect(pane.textareaCell()).toEqual(cursor)
    expect(pane.compositionViewCell()).toBeNull()
  })

  it('never anchors on a highlighted run while the cursor is hidden', async () => {
    const pane = createTranscriptPane()
    await pane.write('\x1b[?25l\x1b[7m› 1. Trust and continue\x1b[27m\r\n  2. Quit\r\n')

    await pane.compose()

    expect(pane.textareaCell()).toEqual({ row: 2, column: 0 })
    expect(pane.compositionViewCell()).toBeNull()
  })
})
