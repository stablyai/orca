// src/renderer/src/lib/lsp/lsp-conversions.test.ts
import { describe, expect, it } from 'vitest'
import { toHoverContents, toLspLocations, toLspPosition, toMonacoRange } from './lsp-conversions'

const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }

describe('lsp conversions', () => {
  it('converts between 1-based Monaco and 0-based LSP positions', () => {
    expect(toLspPosition({ lineNumber: 3, column: 5 })).toEqual({ line: 2, character: 4 })
    expect(toMonacoRange(range)).toEqual({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 3,
      endColumn: 10
    })
  })

  it('normalizes Location, Location[] and LocationLink[]', () => {
    expect(toLspLocations(null)).toEqual([])
    expect(toLspLocations({ uri: 'file:///a', range })).toEqual([{ uri: 'file:///a', range }])
    expect(
      toLspLocations([{ targetUri: 'file:///b', targetRange: range, targetSelectionRange: range }])
    ).toEqual([{ uri: 'file:///b', range }])
    expect(toLspLocations([{ nope: true }])).toEqual([])
  })

  it('renders every hover content shape as markdown', () => {
    expect(toHoverContents('plain')).toEqual([{ value: 'plain' }])
    expect(toHoverContents({ language: 'ruby', value: 'def a' })).toEqual([
      { value: '```ruby\ndef a\n```' }
    ])
    expect(toHoverContents({ kind: 'markdown', value: '**x**' })).toEqual([{ value: '**x**' }])
    expect(toHoverContents([{ kind: 'plaintext', value: 'a*b' }])).toEqual([{ value: 'a\\*b' }])
    expect(toHoverContents(undefined)).toEqual([])
  })
})
