// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleMonacoLargeTextPaste } from './monaco-large-text-paste'

type FakeSelection = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

type FakeEdit = {
  range: FakeSelection
  text: string
  forceMoveMarkers?: boolean
}

function pasteEvent(text: string): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? text : '')
    }
  })
  return event
}

function makeEditor() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const model = {}
  let currentModel: object | null = model
  let focused = true
  let selection: FakeSelection = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1
  }
  let value = ''
  const edits: string[] = []
  const undoStops: number[] = []
  const editor = {
    getModel: () => currentModel,
    getContainerDomNode: () => container,
    hasTextFocus: () => focused,
    getSelection: () => selection,
    setSelection: (next: FakeSelection) => {
      selection = next
    },
    executeEdits: (_source: string, nextEdits: FakeEdit[]) => {
      for (const edit of nextEdits) {
        edits.push(edit.text)
        value += edit.text
      }
      return true
    },
    pushUndoStop: () => {
      undoStops.push(1)
      return true
    },
    getValue: () => value
  }
  return {
    container,
    editor,
    edits,
    undoStops,
    setFocused: (next: boolean) => {
      focused = next
    },
    replaceModel: () => {
      currentModel = {}
    }
  }
}

async function flushPromises(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('monaco large text paste', () => {
  it('leaves small, read-only, and already-owned paste to existing Monaco behavior', () => {
    const { editor } = makeEditor()
    const smallPaste = pasteEvent('small')
    const readOnlyPaste = pasteEvent('x'.repeat(128))
    const handledPaste = pasteEvent('x'.repeat(128))
    handledPaste.preventDefault()

    expect(handleMonacoLargeTextPaste(editor as never, smallPaste, { directMaxBytes: 64 })).toEqual(
      { status: 'ignored', reason: 'small' }
    )
    expect(
      handleMonacoLargeTextPaste(editor as never, readOnlyPaste, {
        readOnly: true,
        directMaxBytes: 8
      })
    ).toEqual({ status: 'ignored', reason: 'read-only' })
    expect(handleMonacoLargeTextPaste(editor as never, handledPaste)).toEqual({
      status: 'ignored',
      reason: 'already-handled'
    })
    expect(smallPaste.defaultPrevented).toBe(false)
  })

  it('chunks large Monaco paste edits and reports one completed owner result', async () => {
    const { editor, edits, undoStops } = makeEditor()
    const resultSpy = vi.fn()
    const startSpy = vi.fn()
    const yieldToEventLoop = vi.fn(async () => {})
    const event = pasteEvent('abcdef'.repeat(4))

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop,
      onPasteStart: startSpy,
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual(['abcdef', 'abcdef', 'abcdef', 'abcdef'])
    expect(yieldToEventLoop).toHaveBeenCalledTimes(3)
    expect(undoStops).toHaveLength(2)
    expect(startSpy).toHaveBeenCalledOnce()
    expect(resultSpy).toHaveBeenCalledWith({
      status: 'pasted',
      mode: 'chunked',
      byteLength: 24,
      chunksWritten: 4
    })
  })

  it('claims large Monaco paste with bounded ownership measuring before yielded insertion', async () => {
    const { editor, edits } = makeEditor()
    const resultSpy = vi.fn()
    const yieldToEventLoop = vi.fn(async () => {})
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const text = 'x'.repeat(32)
    const event = pasteEvent(text)

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 4,
      chunkMaxBytes: 64,
      maxBytes: 64,
      measureYieldAfterCodeUnits: 8,
      yieldToEventLoop,
      onPasteResult: resultSpy
    })

    expect(result).toEqual({ status: 'handled' })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual([])
    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)

    await flushPromises()

    expect(edits.join('')).toBe(text)
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(resultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pasted', mode: 'chunked' })
    )
  })

  it('updates Monaco selection for mixed newlines without splitting chunk text', async () => {
    const { editor, edits } = makeEditor()
    const split = vi.spyOn(String.prototype, 'split')
    const text = 'a\r\nbb\nc\rd'
    const event = pasteEvent(text)

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 1,
      chunkMaxBytes: 64
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(edits).toEqual([text])
    expect(editor.getSelection()).toMatchObject({
      endColumn: 2,
      endLineNumber: 4,
      startColumn: 2,
      startLineNumber: 4
    })
    expect(split).not.toHaveBeenCalled()
  })

  it('cancels chunking when focus leaves the original Monaco target', async () => {
    const { editor, edits, setFocused } = makeEditor()
    const resultSpy = vi.fn()
    const event = pasteEvent('abcdef'.repeat(4))

    handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop: async () => {
        setFocused(false)
      },
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(edits).toEqual(['abcdef'])
    expect(resultSpy).toHaveBeenCalledWith({
      status: 'cancelled',
      reason: 'target-unavailable',
      byteLength: 24,
      chunksWritten: 1
    })
  })

  it('cancels chunking when Monaco switches models during paste', async () => {
    const { editor, edits, replaceModel } = makeEditor()
    const resultSpy = vi.fn()
    const event = pasteEvent('abcdef'.repeat(4))

    handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop: async () => {
        replaceModel()
      },
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(edits).toEqual(['abcdef'])
    expect(resultSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled', reason: 'target-unavailable' })
    )
  })

  it('rejects oversized Monaco paste without inserting clipboard content', async () => {
    const { editor, edits } = makeEditor()
    const resultSpy = vi.fn()
    const secret = 'secret-token-value'
    const event = pasteEvent(secret)

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 4,
      maxBytes: 8,
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(resultSpy).toHaveBeenCalledWith({
      status: 'rejected',
      reason: 'too-large',
      byteLength: 9,
      chunksWritten: 0
    })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual([])
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(resultSpy.mock.calls)).not.toContain(secret)
  })

  it('rejects multibyte oversized Monaco paste with bounded byte measurement', async () => {
    const { editor, edits } = makeEditor()
    const resultSpy = vi.fn()
    const event = pasteEvent('😀'.repeat(100))

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 4,
      maxBytes: 5,
      onPasteResult: resultSpy
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(resultSpy).toHaveBeenCalledWith({
      status: 'rejected',
      reason: 'too-large',
      byteLength: 8,
      chunksWritten: 0
    })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual([])
  })

  it('rejects oversized Monaco paste even when the direct threshold is larger', () => {
    const { editor, edits } = makeEditor()
    const event = pasteEvent('abcdef')

    const result = handleMonacoLargeTextPaste(editor as never, event, {
      directMaxBytes: 64,
      maxBytes: 5
    })

    expect(result).toEqual({
      status: 'rejected',
      reason: 'too-large',
      byteLength: 6,
      chunksWritten: 0
    })
    expect(event.defaultPrevented).toBe(true)
    expect(edits).toEqual([])
  })
})
