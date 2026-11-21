import { describe, expect, it } from 'vitest'
import { editFilesFromToolPair } from './native-chat-edit-normalize'

describe('Pi file-edit cards', () => {
  it('builds a card from a completed Pi edit call', () => {
    expect(
      editFilesFromToolPair({
        name: 'edit',
        state: 'completed',
        input: {
          path: 'src/app.ts',
          edits: [{ oldText: 'const a = 1', newText: 'const a = 2' }]
        }
      })
    ).toEqual([
      {
        path: 'src/app.ts',
        oldPath: null,
        changeKind: 'edited',
        lines: [
          { kind: 'del', text: 'const a = 1', oldLineNumber: null, newLineNumber: null },
          { kind: 'add', text: 'const a = 2', oldLineNumber: null, newLineNumber: null }
        ],
        added: 1,
        removed: 1,
        lineNumbersKnown: false,
        truncated: false
      }
    ])
  })

  it('builds a card from a completed Pi write call', () => {
    expect(
      editFilesFromToolPair({
        name: 'write',
        state: 'completed',
        input: { path: 'notes.md', content: 'hello' }
      })
    ).toEqual([
      {
        path: 'notes.md',
        oldPath: null,
        changeKind: 'edited',
        lines: [{ kind: 'add', text: 'hello', oldLineNumber: null, newLineNumber: 1 }],
        added: 1,
        removed: 0,
        lineNumbersKnown: true,
        truncated: false
      }
    ])
  })
})
