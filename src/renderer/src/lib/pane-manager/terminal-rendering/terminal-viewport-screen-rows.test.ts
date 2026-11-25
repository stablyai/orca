import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { findOrchestrationPointerSpans } from '../../../../../shared/orchestration/mailbox/orchestration-pointer-screen-match'
import { viewportScreenRows } from './terminal-viewport-screen-rows'

const POINTER =
  'You have 1 orchestration message. Run `orca orchestration check --terminal term_a`.'

async function screen(cols: number, text: string): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows: 24, allowProposedApi: true })
  await new Promise<void>((resolve) => terminal.write(text, resolve))
  return terminal
}

function covered(terminal: Terminal): { text: string; firstCell: string } | null {
  const buffer = terminal.buffer.active
  const rows = viewportScreenRows(terminal.rows, buffer)
  if (!rows) {
    return null
  }
  const spans = findOrchestrationPointerSpans(rows)
  const text = spans
    .map((span) => buffer.getLine(span.row)?.translateToString(true, span.start, span.end) ?? '')
    .join('')
  return {
    text,
    firstCell: buffer.getLine(spans[0].row)?.getCell(spans[0].start)?.getChars() ?? ''
  }
}

describe('viewportScreenRows', () => {
  it('reads a pointer whose words the terminal soft-wraps mid-word', async () => {
    // At 16 columns no single row holds the word "orchestration".
    const terminal = await screen(16, POINTER)
    expect(covered(terminal)?.text).toBe(POINTER)
  })

  it('maps text after an emoji to the cells it is drawn in', async () => {
    const terminal = await screen(200, `ok 🙂 ${POINTER}`)
    expect(covered(terminal)).toEqual({ text: POINTER, firstCell: 'Y' })
  })

  it('skips a screen that never mentions orchestration', async () => {
    const terminal = await screen(80, 'plain output\r\nmore output')
    expect(viewportScreenRows(terminal.rows, terminal.buffer.active)).toBeNull()
  })
})
