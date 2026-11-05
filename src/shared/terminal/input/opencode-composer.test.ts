import { describe, expect, it } from 'vitest'
import { readOpenCodeComposerText } from './opencode-composer'

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

describe('readOpenCodeComposerText', () => {
  it.each([
    ['the stock placeholder', box(['Ask anything… "Fix a TODO in the codebase"'], 0, '')],
    ['the shell placeholder', box(['Run a command… "git status"'], 0, '', { metadata: 'Shell' })],
    ['a placeholder clipped by a narrow pane', box(['Ask anything…'], 0, '', { metadata: '' })],
    ['a placeholder cut off at the box edge', box(['Ask anythin'], 0, '', { metadata: '' })],
    ['a cut-off shell placeholder', box(['Run a c'], 0, '', { metadata: 'Shell' })],
    ['a transparent theme', box(['Ask anything… "Fix broken tests"'], 0, '', { bottom: '' })]
  ])('reads an empty box showing %s as empty', (_label, context) => {
    expect(readOpenCodeComposerText(context)).toBe('')
  })

  it.each([
    ['at its end', box(['please refactor the auth'], 0, 'please refactor the auth')],
    ['with the cursor moved to its start', box(['please refactor the auth'], 0, '')],
    ['that starts like the placeholder', box(['Ask anything about the failure'], 0, '')],
    [
      'that is a short stock prefix in a wide box',
      {
        ...box(['Ask'], 0, ''),
        rows: ['   /update to install', `   ┃${' '.repeat(60)}`, '   ┃  Ask']
      }
    ],
    ['in shell mode', box(['ls -la'], 0, 'ls -la', { metadata: 'Shell' })],
    ['under a model-only metadata row', box(['fix it'], 0, 'fix it', { metadata: 'Big Pickle' })],
    ['on a transparent theme', box(['fix it'], 0, 'fix it', { bottom: '' })]
  ])('reads a typed draft %s, without the metadata row', (_label, context) => {
    expect(readOpenCodeComposerText(context)).toBe(context.rows.at(-1)?.slice(6))
  })

  it('reads every line of a multi-line draft around the cursor', () => {
    expect(readOpenCodeComposerText(box(['first line', '', 'third line'], 1, ''))).toBe(
      'first line\n\nthird line'
    )
  })

  it('returns null when the cursor is outside a box', () => {
    expect(
      readOpenCodeComposerText({
        ...box(['fix it'], 0, 'fix it'),
        rows: ['$ ls'],
        beforeCursor: '$ ls'
      })
    ).toBeNull()
  })
})
