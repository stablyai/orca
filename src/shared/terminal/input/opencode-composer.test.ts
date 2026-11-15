import { describe, expect, it } from 'vitest'
import { openCodeComposerHoldsDraft } from './opencode-composer'

// OpenCode 2.2's box: a padding row, the textarea, a spacer row, a metadata row; `╹▀` closes it on
// opaque themes only. The cursor sits in the textarea.
function box(
  textRows: string[],
  cursorRow: number,
  beforeCursor: string,
  { metadata = 'Build · gpt-6.1 · medium', bottom = '   ╹▀▀▀▀▀▀▀▀' } = {}
) {
  const rows = ['   ┃', ...textRows.map((row) => `   ┃  ${row}`), '   ┃', `   ┃  ${metadata}`]
  const below = [...rows.slice(cursorRow + 2), ...(bottom ? [bottom] : [])]
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

// OpenCode paints the padding row across the box, so its width shows short text is not clipped.
function wideBox(typed: string) {
  return {
    ...box([typed], 0, ''),
    rows: ['   /update to install', `   ┃${' '.repeat(60)}`, `   ┃  ${typed}`]
  }
}

// A Shell footer that a very narrow pane wraps onto a second metadata row.
function wrappedFooter(textRows: string[], cursorRow: number) {
  const narrow = box(textRows, cursorRow, '', { metadata: 'Shel' })
  const rowsBelow = [...narrow.rowsBelow.slice(0, -1), '   ┃  l', ...narrow.rowsBelow.slice(-1)]
  return { ...narrow, rowsBelow, typedRowsBelow: rowsBelow }
}

describe('openCodeComposerHoldsDraft', () => {
  it.each([
    ['the stock placeholder', box(['Ask anything… "Fix a TODO in the codebase"'], 0, '')],
    ['the shell placeholder', box(['Run a command… "git status"'], 0, '', { metadata: 'Shell' })],
    ['a placeholder clipped by a narrow pane', box(['Ask anything…'], 0, '', { metadata: '' })],
    ['a transparent theme', box(['Ask anything… "Fix broken tests"'], 0, '', { bottom: '' })]
  ])('lets mail through an empty box showing %s', (_label, context) => {
    expect(openCodeComposerHoldsDraft(context)).toBe(false)
  })

  it.each([
    ['at its end', box(['please refactor the auth'], 0, 'please refactor the auth')],
    ['with the cursor moved to its start', box(['please refactor the auth'], 0, '')],
    ['that starts like the placeholder', box(['Ask anything about the failure'], 0, '')],
    ['that is the short stock prefix "A", cursor at its start, in a wide box', wideBox('A')],
    ['that is the short stock prefix "Ask", cursor at its start, in a wide box', wideBox('Ask')],
    ['in shell mode', box(['ls -la'], 0, 'ls -la', { metadata: 'Shell' })],
    ['under a model-only metadata row', box(['fix it'], 0, 'fix it', { metadata: 'Big Pickle' })],
    ['on a transparent theme', box(['fix it'], 0, 'fix it', { bottom: '' })],
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
    ['a draft', wrappedFooter(['Ask'], 0)],
    ['a draft below the cursor', wrappedFooter(['', 'fix it'], 0)]
  ])('holds mail for %s under a footer a narrow pane wrapped', (_label, context) => {
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
