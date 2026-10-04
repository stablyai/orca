import { describe, expect, it } from 'vitest'
import { lspRangeToMonaco, toLspPosition } from './lsp-monaco-position-conversion'

describe('lsp-monaco-position-conversion', () => {
  it('converts a 1-based Monaco position to a 0-based LSP position', () => {
    expect(toLspPosition({ lineNumber: 3, column: 5 })).toEqual({ line: 2, character: 4 })
  })

  it('converts a 0-based LSP range to a 1-based Monaco range', () => {
    expect(
      lspRangeToMonaco({ start: { line: 0, character: 0 }, end: { line: 1, character: 7 } })
    ).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 8 })
  })
})
