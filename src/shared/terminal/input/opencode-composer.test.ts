import { describe, expect, it } from 'vitest'
import { openCodeComposerHoldsDraft } from './opencode-composer'

// OpenCode 2.2's box: a padding row, the textarea, a spacer row, a metadata row; `╹▀` closes it on
// opaque themes only. The cursor sits in the textarea.
function box(
  textRows: string[],
  cursorRow: number,
  beforeCursor: string,
  metadata = 'Build · gpt-6.1 · medium'
) {
  const rows = ['   ┃', ...textRows.map((row) => `   ┃  ${row}`), '   ┃', `   ┃  ${metadata}`]
  const below = [...rows.slice(cursorRow + 2), '   ╹▀▀▀▀▀▀▀▀']
  return {
    rows: ['   /update to install', ...rows.slice(0, cursorRow + 2)],
    typedRows: ['   /update to install', ...rows.slice(0, cursorRow + 2)],
    promptGlyphBoldRows: rows.slice(0, cursorRow + 3).map(() => false),
    rowsBelow: below,
    typedRowsBelow: below,
    beforeCursor: `   ┃  ${beforeCursor}`,
    afterCursor: '',
    rawAfterCursor: '',
    cursorHidden: false,
    cursorViewportRow: 10
  }
}

// A Shell footer that a very narrow pane wraps onto a second metadata row.
function wrappedFooter(textRows: string[], cursorRow: number) {
  const narrow = box(textRows, cursorRow, '', 'Shel')
  const rowsBelow = [...narrow.rowsBelow.slice(0, -1), '   ┃  l', ...narrow.rowsBelow.slice(-1)]
  return { ...narrow, rowsBelow, typedRowsBelow: rowsBelow }
}

describe('openCodeComposerHoldsDraft', () => {
  it.each([
    ['the stock placeholder', box(['Ask anything… "Fix a TODO in the codebase"'], 0, '')],
    ['the shell placeholder', box(['Run a command… "git status"'], 0, '', 'Shell')]
  ])('lets mail through an empty box showing %s', (_label, context) => {
    expect(openCodeComposerHoldsDraft(context)).toBe(false)
  })

  it.each([
    ['at its end', box(['please refactor the auth'], 0, 'please refactor the auth')],
    [
      'that starts like the placeholder with the cursor at its start',
      box(['Ask anything… about the failure'], 0, '')
    ],
    ['that a narrow pane cut to look like a clipped placeholder', box(['Ask anythin'], 0, '')],
    ['on a line below the cursor', box(['', 'second line'], 0, '')],
    [
      'that starts with the placeholder on its own line',
      box(['Ask anything…', 'please fix the auth'], 0, '')
    ]
  ])('holds mail for a typed draft %s', (_label, context) => {
    expect(openCodeComposerHoldsDraft(context)).toBe(true)
  })

  it.each([
    ['an empty box under a wrapped footer', wrappedFooter([''], 0)],
    [
      'a placeholder wrapped onto two rows',
      box(['Ask anything… "Fix a TODO in', 'the codebase"'], 0, '')
    ]
  ])('lets mail through %s', (_label, context) => {
    expect(openCodeComposerHoldsDraft(context)).toBe(false)
  })

  it('lets mail through when the cursor is outside a box', () => {
    expect(
      openCodeComposerHoldsDraft({
        ...box(['fix it'], 0, 'fix it'),
        rows: ['$ ls'],
        beforeCursor: '$ ls'
      })
    ).toBe(false)
  })
})
