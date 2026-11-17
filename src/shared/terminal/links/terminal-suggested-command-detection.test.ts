import { describe, expect, it } from 'vitest'
import type { TerminalLinkBuffer, TerminalLinkBufferLine } from './terminal-link-buffer'
import { findTerminalSuggestedCommand } from './terminal-suggested-command-detection'

const COLS = 40

function makeLine(text: string, isWrapped = false): TerminalLinkBufferLine {
  const padded = text.padEnd(COLS, ' ')
  return {
    isWrapped,
    length: COLS,
    translateToString: (_trimRight, startColumn = 0, endColumn = padded.length, outColumns) => {
      outColumns?.push(...Array.from({ length: padded.length + 1 }, (_value, index) => index))
      return padded.slice(startColumn, endColumn)
    }
  }
}

function makeBuffer(rows: (string | { text: string; wrapped: true })[]): TerminalLinkBuffer {
  const lines = rows.map((row) =>
    typeof row === 'string' ? makeLine(row) : makeLine(row.text, row.wrapped)
  )
  return { getLine: (y) => lines[y] }
}

describe('findTerminalSuggestedCommand', () => {
  it('rejoins a command the agent word-wrapped onto an indented row', () => {
    const buffer = makeBuffer([
      '  Run it again:',
      '',
      '  ! ssh deploy@db.example.com "mysql" <',
      '  /tmp/check.sql > /tmp/out; wc -l out',
      '',
      '  - If it is 0, nothing to delete.'
    ])

    for (const lineNumber of [3, 4]) {
      const command = findTerminalSuggestedCommand(buffer, lineNumber)
      expect(command?.text).toBe(
        '! ssh deploy@db.example.com "mysql" < /tmp/check.sql > /tmp/out; wc -l out'
      )
      expect(command?.range).toEqual({ start: { x: 3, y: 3 }, end: { x: 38, y: 4 } })
    }
    expect(findTerminalSuggestedCommand(buffer, 1)).toBeNull()
    expect(findTerminalSuggestedCommand(buffer, 6)).toBeNull()
  })

  it('keeps a short command apart from the explanation on the next row', () => {
    const buffer = makeBuffer(['  ! git status', '  Then tell me what it prints.'])

    expect(findTerminalSuggestedCommand(buffer, 1)?.text).toBe('! git status')
    expect(findTerminalSuggestedCommand(buffer, 2)).toBeNull()
  })

  it('separates consecutive commands and stops at list items', () => {
    const buffer = makeBuffer(['  ! pnpm install', '  ! pnpm test', '  - done'])

    expect(findTerminalSuggestedCommand(buffer, 1)?.text).toBe('! pnpm install')
    expect(findTerminalSuggestedCommand(buffer, 2)?.text).toBe('! pnpm test')
  })

  it('follows an unfinished command even when the agent wrapped narrower than the terminal', () => {
    const buffer = makeBuffer([
      '  ! ssh host "cat <',
      '  /tmp/a" > /tmp/out',
      '  ! cat a |',
      '  wc -l'
    ])

    expect(findTerminalSuggestedCommand(buffer, 2)?.text).toBe(
      '! ssh host "cat < /tmp/a" > /tmp/out'
    )
    expect(findTerminalSuggestedCommand(buffer, 3)?.text).toBe('! cat a | wc -l')
  })

  it('offers nothing when the tail of an unfinished command is missing', () => {
    const buffer = makeBuffer(['  ! cat a >', '', '  more text'])

    expect(findTerminalSuggestedCommand(buffer, 1)).toBeNull()
  })

  it('keeps the space where xterm soft-wrapped at a word boundary', () => {
    const buffer = makeBuffer([
      '! rm -rf build                          ',
      { text: 'dist', wrapped: true }
    ])

    expect(findTerminalSuggestedCommand(buffer, 2)?.text).toBe('! rm -rf build dist')
  })

  it('does not end a wrapped command at a row that starts with a flag', () => {
    const buffer = makeBuffer(['  ! pnpm vitest run src/term/links/x.ts', '  --coverage'])

    expect(findTerminalSuggestedCommand(buffer, 2)?.text).toBe(
      '! pnpm vitest run src/term/links/x.ts --coverage'
    )
  })

  it('joins soft-wrapped rows without inserting a space', () => {
    const buffer = makeBuffer([
      '! echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      { text: 'bbbb', wrapped: true }
    ])

    expect(findTerminalSuggestedCommand(buffer, 2)?.text).toBe(
      '! echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb'
    )
  })

  it('ignores the row holding the cursor so prompt drafts are not offered', () => {
    const buffer = makeBuffer(['  ! git status'])

    expect(findTerminalSuggestedCommand(buffer, 1, 0)).toBeNull()
  })

  it('ignores a bang that is not followed by a command', () => {
    const buffer = makeBuffer(['  !important note', '  ! '])

    expect(findTerminalSuggestedCommand(buffer, 1)).toBeNull()
    expect(findTerminalSuggestedCommand(buffer, 2)).toBeNull()
  })
})
