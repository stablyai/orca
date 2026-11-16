import { describe, expect, it } from 'vitest'
import { isMarkdownPreviewNoteOwnedByRange } from './markdown-preview-block-model'

describe('isMarkdownPreviewNoteOwnedByRange', () => {
  const table = { startLine: 3, endLine: 6, nestedRanges: [{ startLine: 5, endLine: 5 }] }
  const lastRow = { startLine: 6, endLine: 6, containedNotesOnly: true }

  it('gives a single-row note to the row, not the table', () => {
    expect(isMarkdownPreviewNoteOwnedByRange({ lineNumber: 5 }, table)).toBe(false)
  })

  it('keeps a whole-table note on the table, not its last row', () => {
    const note = { startLine: 3, lineNumber: 6 }
    expect(isMarkdownPreviewNoteOwnedByRange(note, table)).toBe(true)
    expect(isMarkdownPreviewNoteOwnedByRange(note, lastRow)).toBe(false)
  })

  it('gives a row its own note', () => {
    expect(isMarkdownPreviewNoteOwnedByRange({ lineNumber: 6 }, lastRow)).toBe(true)
  })
})
