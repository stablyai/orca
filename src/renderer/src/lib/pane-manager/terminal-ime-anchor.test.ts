import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { resolveAppDrawnImeCaret } from './terminal-ime-anchor'

// Recorded with config/scripts/capture-agent-pty-transcript.mjs at 100x30; see each .meta.json.
const FIXTURES = join(__dirname, '../../../../main/runtime/__fixtures__')

function replay(data: string | Uint8Array, cols = 100, rows = 30): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true })
  return new Promise((resolve) => terminal.write(data, () => resolve(terminal)))
}

function replayTranscript(name: string): Promise<Terminal> {
  return replay(readFileSync(join(FIXTURES, `${name}.txt`)))
}

function caretOf(terminal: Terminal): ReturnType<typeof resolveAppDrawnImeCaret> {
  return resolveAppDrawnImeCaret({
    buffer: terminal.buffer.active,
    rows: terminal.rows,
    cols: terminal.cols,
    cursorVisible: terminal.modes.showCursor
  })
}

function charAt(terminal: Terminal, row: number, column: number): string {
  const buffer = terminal.buffer.active
  return (
    buffer
      .getLine(buffer.baseY + row)
      ?.getCell(column)
      ?.getChars() ?? ''
  )
}

type HiddenCursorState = {
  cursor: { row: number; column: number }
  parked: boolean
  caret: ReturnType<typeof resolveAppDrawnImeCaret>
}

// Every escape sequence is a point a composition event could land between two parsed writes.
const ESC = '\\x1b'
const TRANSCRIPT_TOKEN = new RegExp(
  `${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]|${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)|${ESC}[^[\\]]|[^${ESC}]+`,
  'g'
)

/** Samples the rule at every intermediate state of a replay in which the cursor is hidden. */
async function hiddenCursorStates(name: string): Promise<HiddenCursorState[]> {
  const terminal = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  const states: HiddenCursorState[] = []
  const sample = (): void => {
    if (terminal.modes.showCursor) {
      return
    }
    const buffer = terminal.buffer.active
    const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? ''
    states.push({
      cursor: { row: buffer.cursorY, column: buffer.cursorX },
      parked: buffer.cursorX === 0 && line.trim() === '',
      caret: caretOf(terminal)
    })
  }
  const data = readFileSync(join(FIXTURES, `${name}.txt`), 'utf8')
  for (const token of data.match(TRANSCRIPT_TOKEN) ?? []) {
    terminal.write(token, sample)
  }
  await new Promise<void>((resolve) => terminal.write('', resolve))
  return states
}

describe('resolveAppDrawnImeCaret on captured agent transcripts', () => {
  it('finds cursor-agent’s inverse caret on the placeholder while the cursor is parked', async () => {
    const terminal = await replayTranscript('cursor-agent-ime-ready')
    const buffer = terminal.buffer.active

    expect(terminal.modes.showCursor).toBe(false)
    expect({ row: buffer.cursorY, column: buffer.cursorX }).toEqual({ row: 14, column: 0 })
    expect(caretOf(terminal)).toEqual({ row: 9, column: 4 })
    expect(charAt(terminal, 9, 4)).toBe('P')
  })

  it('follows cursor-agent’s caret through Korean, Backspace and Left/Right', async () => {
    const terminal = await replayTranscript('cursor-agent-ime-korean-typed')

    // "→ 안녕 하세요a한b" with the caret moved back onto "b".
    expect(caretOf(terminal)).toEqual({ row: 9, column: 18 })
    expect(charAt(terminal, 9, 18)).toBe('b')
    expect(terminal.buffer.active.cursorY).toBe(14)
  })

  it.each([
    ['claude-code-ime-korean-typed', { row: 26, column: 16 }],
    ['codex-ime-korean-typed', { row: 10, column: 16 }],
    ['grok-ime-korean-typed', { row: 25, column: 20 }]
  ])('leaves %s to its shown cursor, which already sits on the caret', async (name, cursor) => {
    const terminal = await replayTranscript(name)
    const buffer = terminal.buffer.active

    expect(terminal.modes.showCursor).toBe(true)
    expect(caretOf(terminal)).toBeNull()
    expect({ row: buffer.cursorY, column: buffer.cursorX }).toEqual(cursor)
    expect(charAt(terminal, cursor.row, cursor.column)).toBe('b')
  })

  it('does not take a highlighted run for a caret', async () => {
    const terminal = await replay(
      '\x1b[?25l\x1b[7m› 1. Trust and continue\x1b[27m\r\n  2. Quit',
      40,
      4
    )

    expect(caretOf(terminal)).toBeNull()
  })

  it('prefers the lone inverse cell nearest the parked cursor', async () => {
    const terminal = await replay(
      '\x1b[?25l\x1b[7m \x1b[27m\r\n\r\n→ hi\x1b[7m \x1b[27m\r\n',
      20,
      4
    )

    expect(caretOf(terminal)).toEqual({ row: 2, column: 4 })
  })

  // A wide character's second cell has width 0; it must not break a highlight run in two.
  it.each([
    ['a run of wide characters', '\x1b[7m안녕\x1b[27m'],
    ['a narrow cell before a wide one', '\x1b[7ma안\x1b[27m'],
    ['a wide cell before a narrow one', '\x1b[7m안a\x1b[27m'],
    ['a highlighted Korean menu row', '\x1b[7m› 1. 신뢰하고 계속\x1b[27m']
  ])('does not take %s for a caret', async (_name, row) => {
    const terminal = await replay(`\x1b[?25l${row}\r\n  2. 종료`, 40, 4)

    expect(caretOf(terminal)).toBeNull()
  })

  it('takes a lone inverse wide character for the caret it sits on', async () => {
    const terminal = await replay('\x1b[?25l→ 안\x1b[7m녕\x1b[27m하\r\n', 20, 4)

    expect(caretOf(terminal)).toEqual({ row: 0, column: 4 })
  })

  it('finds the caret after a highlight of wide characters on the same row', async () => {
    const terminal = await replay('\x1b[?25l\x1b[7m세요\x1b[27m x\x1b[7m \x1b[27m\r\n', 20, 4)

    expect(caretOf(terminal)).toEqual({ row: 0, column: 6 })
  })

  // Why no parked-cursor gate: the other agents hide the cursor around nearly every repaint but
  // never paint a lone inverse cell, while cursor-agent is mid-repaint (cursor not parked) in most
  // of the states that show its caret.
  it.each(['claude-code-ime-korean-typed', 'codex-ime-korean-typed', 'grok-ime-korean-typed'])(
    'never relocates %s at any hidden-cursor state of its repaints',
    async (name) => {
      const states = await hiddenCursorStates(name)

      expect(states.length).toBeGreaterThan(200)
      expect(states.filter((state) => state.caret !== null)).toEqual([])
    }
  )

  it('finds cursor-agent’s caret on its input row mid-repaint, not only while parked', async () => {
    const states = (await hiddenCursorStates('cursor-agent-ime-korean-typed')).filter(
      (state) => state.caret !== null
    )
    const midRepaint = states.filter((state) => !state.parked)

    expect(midRepaint.length).toBeGreaterThan(states.length / 2)
    expect(new Set(states.map((state) => state.caret?.row))).toEqual(new Set([9]))
  })
})
