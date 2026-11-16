import { describe, expect, it } from 'vitest'
import { isMarkdownPreviewNoteOwnedByRange } from './markdown-preview-block-model'

describe('isMarkdownPreviewNoteOwnedByRange', () => {
  const firstRow = { startLine: 5, endLine: 5, containedNotesOnly: true }
  const lastRow = { startLine: 6, endLine: 6, containedNotesOnly: true }
  const table = { startLine: 3, endLine: 6, nestedRanges: [firstRow, lastRow] }

  function owners(note: { startLine?: number; lineNumber: number }): string[] {
    return Object.entries({ table, firstRow, lastRow })
      .filter(([, range]) => isMarkdownPreviewNoteOwnedByRange(note, range))
      .map(([name]) => name)
  }

  it('gives each single-row note to its row only', () => {
    expect(owners({ lineNumber: 5 })).toEqual(['firstRow'])
    expect(owners({ lineNumber: 6 })).toEqual(['lastRow'])
  })

  it('keeps a note spanning rows on the table only', () => {
    expect(owners({ startLine: 5, lineNumber: 6 })).toEqual(['table'])
  })

  it('keeps a whole-table note on the table, not its last row', () => {
    expect(owners({ startLine: 3, lineNumber: 6 })).toEqual(['table'])
  })
})
