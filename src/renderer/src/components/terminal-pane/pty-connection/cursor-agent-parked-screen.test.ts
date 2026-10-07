import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { IBuffer } from '@xterm/headless'
import { resolveParkedCursorAgentInput } from './cursor-agent-parked-screen'

/** The screen as xterm parses it: one row per line, 80 columns, no scrollback. */
function makeBuffer(lines: string[], cols = 80): Promise<IBuffer> {
  const terminal = new Terminal({ cols, rows: lines.length, allowProposedApi: true })
  return new Promise((resolve) =>
    terminal.write(lines.join('\r\n'), () => resolve(terminal.buffer.active))
  )
}

describe('resolveParkedCursorAgentInput', () => {
  it('anchors an empty Cursor Agent prompt at the visible prompt caret', async () => {
    const buffer = await makeBuffer([
      '',
      '  Cursor Agent',
      '  v2026.06.29-2ad2186',
      '  Tip: Use /config to customize Cursor settings and behavior.',
      '',
      '',
      '',
      '',
      '  → Plan, search, build anything',
      '',
      '',
      '  Composer 2.5',
      '  ~/development/code/xinyue/app_android · develop/app6.5.1',
      ''
    ])

    expect(
      resolveParkedCursorAgentInput({
        buffer,
        rows: 14,
        cols: 80,
        cursorX: 0,
        cursorY: 13
      })
    ).toEqual({ row: 8, column: 4 })
  })

  it('does not override normal terminal cursor positioning', async () => {
    const buffer = await makeBuffer(['', '  → ordinary shell output', '', ''])

    expect(
      resolveParkedCursorAgentInput({
        buffer,
        rows: 4,
        cols: 80,
        cursorX: 0,
        cursorY: 3
      })
    ).toBeNull()
  })

  it('anchors the follow-up placeholder after the Cursor Agent header scrolls away', async () => {
    const buffer = await makeBuffer(['transcript', '', '  → Add a follow-up', '', ''])

    expect(
      resolveParkedCursorAgentInput({
        buffer,
        rows: 5,
        cols: 80,
        cursorX: 0,
        cursorY: 4
      })
    ).toEqual({ row: 2, column: 4 })
  })

  it('does not override when xterm already exposes a non-stale cursor position', async () => {
    const buffer = await makeBuffer(['', '  Cursor Agent', '', '  → Plan, search, build anything'])

    expect(
      resolveParkedCursorAgentInput({
        buffer,
        rows: 4,
        cols: 80,
        cursorX: 4,
        cursorY: 3
      })
    ).toBeNull()
  })

  it('anchors the input row, not a transcript line containing an arrow', async () => {
    const buffer = await makeBuffer([
      '',
      '  Cursor Agent',
      '',
      '  Renamed a.ts → b.ts',
      '',
      '  → Plan, search, build anything',
      ''
    ])

    expect(
      resolveParkedCursorAgentInput({
        buffer,
        rows: 7,
        cols: 80,
        cursorX: 0,
        cursorY: 6
      })
    ).toEqual({ row: 5, column: 4 })
  })

  it('uses cell width when anchoring after typed Cursor Agent input', async () => {
    const buffer = await makeBuffer(['', '  Cursor Agent', '', '  → hi你', ''])

    expect(
      resolveParkedCursorAgentInput({
        buffer,
        rows: 5,
        cols: 80,
        cursorX: 0,
        cursorY: 4
      })
    ).toEqual({ row: 3, column: 8 })
  })
})
