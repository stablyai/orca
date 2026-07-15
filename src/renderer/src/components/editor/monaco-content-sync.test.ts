import { describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import { syncContentOnMount, syncContentUpdate } from './monaco-content-sync'

function createHarness(
  initialContent: string,
  eol = '\n'
): {
  editorInstance: editor.IStandaloneCodeEditor
  getValue: ReturnType<typeof vi.fn>
  getFullModelRange: ReturnType<typeof vi.fn>
  applyEdits: ReturnType<typeof vi.fn>
  pushEditOperations: ReturnType<typeof vi.fn>
  pushUndoStop: ReturnType<typeof vi.fn>
} {
  const getValue = vi.fn(() => initialContent)
  const getFullModelRange = vi.fn(() => ({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 3,
    endColumn: 5
  }))
  const pushEditOperations = vi.fn()
  const applyEdits = vi.fn()
  const model = {
    getValue,
    getEOL: () => eol,
    getFullModelRange,
    pushEditOperations,
    applyEdits
  } as unknown as editor.ITextModel
  const pushUndoStop = vi.fn()
  const editorInstance = {
    getModel: () => model,
    pushUndoStop
  } as unknown as editor.IStandaloneCodeEditor
  return {
    editorInstance,
    getValue,
    getFullModelRange,
    applyEdits,
    pushEditOperations,
    pushUndoStop
  }
}

describe('monaco content sync', () => {
  it('inserts only an append-only suffix at the model end', () => {
    const harness = createHarness('first\nsecond\nlast')

    syncContentUpdate(harness.editorInstance, 'first\nsecond\nlast\nnext')

    expect(harness.getValue).toHaveBeenCalledTimes(1)
    expect(harness.getFullModelRange).toHaveBeenCalledTimes(1)
    expect(harness.pushEditOperations).toHaveBeenCalledWith(
      [],
      [
        {
          range: {
            startLineNumber: 3,
            startColumn: 5,
            endLineNumber: 3,
            endColumn: 5
          },
          text: '\nnext'
        }
      ],
      expect.any(Function)
    )
    expect(harness.pushUndoStop).toHaveBeenCalledTimes(2)
  })

  it('inserts a read-only live-tail suffix without recording undo history', () => {
    const harness = createHarness('first\nsecond\nlast')

    syncContentUpdate(harness.editorInstance, 'first\nsecond\nlast\nnext', 'read-only-live-tail')

    expect(harness.applyEdits).toHaveBeenCalledWith([
      {
        range: {
          startLineNumber: 3,
          startColumn: 5,
          endLineNumber: 3,
          endColumn: 5
        },
        text: '\nnext'
      }
    ])
    expect(harness.pushEditOperations).not.toHaveBeenCalled()
    expect(harness.pushUndoStop).not.toHaveBeenCalled()
  })

  it('does nothing for identical content', () => {
    const harness = createHarness('unchanged')

    syncContentUpdate(harness.editorInstance, 'unchanged')

    expect(harness.getValue).toHaveBeenCalledTimes(1)
    expect(harness.getFullModelRange).not.toHaveBeenCalled()
    expect(harness.pushEditOperations).not.toHaveBeenCalled()
    expect(harness.pushUndoStop).not.toHaveBeenCalled()
  })

  it.each([
    [
      'CRLF file content into an LF model',
      'first\nsecond\nlast',
      '\n',
      'first\r\nsecond\r\nlast\r\nnext',
      '\nnext'
    ],
    [
      'LF file content into a CRLF model',
      'first\r\nsecond\r\nlast',
      '\r\n',
      'first\nsecond\nlast\nnext',
      '\r\nnext'
    ],
    [
      'mixed file content into an LF model',
      'first\nsecond\nlast',
      '\n',
      'first\r\nsecond\rlast\nnext',
      '\nnext'
    ]
  ])(
    'keeps %s on the suffix path',
    (_label, initialContent, modelEol, nextContent, expectedSuffix) => {
      const harness = createHarness(initialContent, modelEol)

      syncContentUpdate(harness.editorInstance, nextContent)

      expect(harness.pushEditOperations).toHaveBeenCalledWith(
        [],
        [expect.objectContaining({ text: expectedSuffix })],
        expect.any(Function)
      )
      expect(harness.pushUndoStop).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['same-length rewrite', 'before', 'after!'],
    ['prefix mismatch', 'before', 'changed content'],
    ['truncation', 'longer content', 'short']
  ])('fully replaces a %s', (_label, initialContent, nextContent) => {
    const harness = createHarness(initialContent)

    syncContentUpdate(harness.editorInstance, nextContent)

    expect(harness.getValue).toHaveBeenCalledTimes(1)
    expect(harness.pushEditOperations).toHaveBeenCalledWith(
      [],
      [{ range: harness.getFullModelRange.mock.results[0]?.value, text: nextContent }],
      expect.any(Function)
    )
    expect(harness.pushUndoStop).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['same-length rewrite', 'before', 'after!'],
    ['prefix mismatch', 'before', 'changed content'],
    ['truncation', 'longer content', 'short']
  ])('non-undoingly replaces a read-only live-tail %s', (_label, initialContent, nextContent) => {
    const harness = createHarness(initialContent)

    syncContentUpdate(harness.editorInstance, nextContent, 'read-only-live-tail')

    expect(harness.applyEdits).toHaveBeenCalledWith([
      { range: harness.getFullModelRange.mock.results[0]?.value, text: nextContent }
    ])
    expect(harness.pushEditOperations).not.toHaveBeenCalled()
    expect(harness.pushUndoStop).not.toHaveBeenCalled()
  })

  it('reconciles a stale retained model on mount without undo stops', () => {
    const harness = createHarness('stale')

    expect(syncContentOnMount(harness.editorInstance, 'fresh')).toBe(true)

    expect(harness.pushEditOperations).toHaveBeenCalledTimes(1)
    expect(harness.pushUndoStop).not.toHaveBeenCalled()
  })

  it('reconciles a stale read-only live-tail model on mount without undo history', () => {
    const harness = createHarness('stale')

    expect(syncContentOnMount(harness.editorInstance, 'fresh', 'read-only-live-tail')).toBe(true)

    expect(harness.applyEdits).toHaveBeenCalledTimes(1)
    expect(harness.pushEditOperations).not.toHaveBeenCalled()
    expect(harness.pushUndoStop).not.toHaveBeenCalled()
  })

  it('does nothing on mount when content already matches', () => {
    const harness = createHarness('same')

    expect(syncContentOnMount(harness.editorInstance, 'same')).toBe(false)

    expect(harness.pushEditOperations).not.toHaveBeenCalled()
    expect(harness.pushUndoStop).not.toHaveBeenCalled()
  })

  it('does nothing on mount when only raw file EOLs differ from the model', () => {
    const harness = createHarness('first\nsecond')

    expect(syncContentOnMount(harness.editorInstance, 'first\r\nsecond')).toBe(false)

    expect(harness.pushEditOperations).not.toHaveBeenCalled()
    expect(harness.pushUndoStop).not.toHaveBeenCalled()
  })

  it('reconciles only the retained target model after a path switch', () => {
    const priorPath = createHarness('prior path with user edits')
    const targetPath = createHarness('stale target')

    syncContentOnMount(targetPath.editorInstance, 'fresh target')

    expect(targetPath.pushEditOperations).toHaveBeenCalledTimes(1)
    expect(targetPath.pushUndoStop).not.toHaveBeenCalled()
    expect(priorPath.pushEditOperations).not.toHaveBeenCalled()
    expect(priorPath.pushUndoStop).not.toHaveBeenCalled()
  })
})
