import { describe, expect, it } from 'vitest'
import { formatCopiedSelectionWithContext, getContextualCopyLineRange } from './selection-copy'

describe('formatCopiedSelectionWithContext', () => {
  it('formats multi-line selections with file and line context', () => {
    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'src/main/git/status.ts',
        language: 'typescript',
        selection: {
          startLineNumber: 44,
          startColumn: 1,
          endLineNumber: 47,
          endColumn: 9
        },
        selectedText: "if (line.startsWith('1 ')) {\n  const parts = line.split(' ')\n}"
      })
    ).toBe(
      [
        'File: src/main/git/status.ts',
        'Lines: 44-47',
        '',
        '```ts',
        "if (line.startsWith('1 ')) {\n  const parts = line.split(' ')\n}",
        '```'
      ].join('\n')
    )
  })

  it('treats column-1 end positions as the previous line for full-line selections', () => {
    const selection = {
      startLineNumber: 44,
      startColumn: 1,
      endLineNumber: 48,
      endColumn: 1
    }

    expect(getContextualCopyLineRange(selection)).toEqual({
      startLine: 44,
      endLine: 47
    })

    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'src/main/git/status.ts',
        language: 'typescript',
        selection,
        selectedText: 'line 44\nline 45\nline 46\nline 47\n'
      })
    ).toContain('Lines: 44-47')
  })

  it('keeps full-line single-line selections copyable', () => {
    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'src/main/git/status.ts',
        language: 'typescript',
        selection: {
          startLineNumber: 44,
          startColumn: 1,
          endLineNumber: 45,
          endColumn: 1
        },
        selectedText: 'line 44\n'
      })
    ).toContain('Line: 44')
  })

  it('leaves single-line selections alone', () => {
    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'src/main/git/status.ts',
        language: 'typescript',
        selection: {
          startLineNumber: 44,
          startColumn: 4,
          endLineNumber: 44,
          endColumn: 15
        },
        selectedText: 'line.startsWith'
      })
    ).toBeNull()
  })
})
