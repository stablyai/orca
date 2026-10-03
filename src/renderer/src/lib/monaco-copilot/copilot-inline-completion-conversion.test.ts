import { describe, expect, it } from 'vitest'
import { copilotInlineCompletionsToMonaco } from './copilot-inline-completion-conversion'

describe('copilotInlineCompletionsToMonaco', () => {
  it('maps items with 0-based LSP ranges to 1-based Monaco ranges', () => {
    const items = copilotInlineCompletionsToMonaco(
      {
        items: [
          {
            insertText: 'return a + b',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }
          }
        ]
      },
      '\n'
    )
    expect(items).toEqual([
      {
        insertText: 'return a + b',
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 }
      }
    ])
  })

  it('normalizes newlines to the model EOL and skips empty items', () => {
    const items = copilotInlineCompletionsToMonaco(
      { items: [{ insertText: 'a\nb' }, { insertText: '' }, { nope: true }] },
      '\r\n'
    )
    expect(items).toEqual([{ insertText: 'a\r\nb', range: undefined }])
  })

  it('accepts a bare array and tolerates null', () => {
    expect(copilotInlineCompletionsToMonaco([{ insertText: 'x' }], '\n')).toHaveLength(1)
    expect(copilotInlineCompletionsToMonaco(null, '\n')).toEqual([])
  })
})
