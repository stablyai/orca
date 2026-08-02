// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  addLargeTextControlPasteListener,
  findLargeTextControlPasteTarget,
  handleLargeTextControlPasteEvent
} from './large-text-control-paste'

function appendTextarea(value = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.value = value
  document.body.appendChild(textarea)
  return textarea
}

function makePasteEvent(text: string): ClipboardEvent {
  const event = new Event('paste', {
    bubbles: true,
    cancelable: true
  }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? text : '')
    }
  })
  return event
}

function captureInputEvents(target: HTMLElement): InputEvent[] {
  const events: InputEvent[] = []
  target.addEventListener('input', (event) => {
    events.push(event as InputEvent)
  })
  return events
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

describe('large text control paste', () => {
  it('leaves small paste payloads to the browser default path', () => {
    const textarea = appendTextarea()
    textarea.focus()
    const event = makePasteEvent('small')

    textarea.dispatchEvent(event)
    const result = handleLargeTextControlPasteEvent(event, { directMaxBytes: 64 })

    expect(result).toEqual({ status: 'ignored', reason: 'small' })
    expect(event.defaultPrevented).toBe(false)
    expect(textarea.value).toBe('')
  })

  it('chunks large paste payloads into focused text controls', async () => {
    const textarea = appendTextarea('prefix ')
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const inputEvents = captureInputEvents(textarea)
    const pasteResult = vi.fn()
    const yieldToEventLoop = vi.fn(async () => {})
    const text = 'abcdef'.repeat(6)
    const event = makePasteEvent(text)

    textarea.dispatchEvent(event)
    const result = handleLargeTextControlPasteEvent(event, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop,
      onPasteResult: pasteResult
    })
    await flushPromises()

    expect(result).toEqual({ status: 'handled' })
    expect(event.defaultPrevented).toBe(true)
    expect(textarea.value).toBe(`prefix ${text}`)
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(pasteResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pasted', mode: 'chunked' })
    )
    expect(inputEvents).toHaveLength(1)
    expect(inputEvents[0].inputType).toBe('insertFromPaste')
    expect(inputEvents[0].data ?? '').toBe('')
  })

  it('claims large paste events with bounded ownership measuring before async insertion', async () => {
    const textarea = appendTextarea()
    textarea.focus()
    const pasteResult = vi.fn()
    const yieldToEventLoop = vi.fn(async () => {})
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const text = 'x'.repeat(32)
    const event = makePasteEvent(text)

    textarea.dispatchEvent(event)
    const result = handleLargeTextControlPasteEvent(event, {
      chunkMaxBytes: 64,
      directMaxBytes: 4,
      maxBytes: 64,
      measureYieldAfterCodeUnits: 8,
      onPasteResult: pasteResult,
      yieldToEventLoop
    })

    expect(result).toEqual({ status: 'handled' })
    expect(event.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('')
    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)

    await flushPromises()

    expect(textarea.value).toBe(text)
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(pasteResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pasted', mode: 'chunked' })
    )
  })

  it('ignores terminal helper textareas and already-handled paste events', () => {
    const terminalRoot = document.createElement('div')
    terminalRoot.className = 'xterm-helper-textarea'
    const terminalTextarea = document.createElement('textarea')
    terminalRoot.appendChild(terminalTextarea)
    document.body.appendChild(terminalRoot)
    terminalTextarea.focus()
    const terminalPaste = makePasteEvent('x'.repeat(128))
    terminalTextarea.dispatchEvent(terminalPaste)

    expect(
      handleLargeTextControlPasteEvent(terminalPaste, {
        directMaxBytes: 8
      })
    ).toEqual({ status: 'ignored', reason: 'not-text-control' })

    const textarea = appendTextarea()
    textarea.focus()
    const handledPaste = makePasteEvent('x'.repeat(128))
    handledPaste.preventDefault()
    textarea.dispatchEvent(handledPaste)

    expect(handleLargeTextControlPasteEvent(handledPaste, { directMaxBytes: 8 })).toEqual({
      status: 'ignored',
      reason: 'already-handled'
    })
  })

  it('rejects oversized paste before mutating the focused text control', () => {
    const textarea = appendTextarea('safe')
    textarea.focus()
    const pasteResult = vi.fn()
    const event = makePasteEvent('abcdef')
    const now = vi.fn()
    now.mockReturnValueOnce(20).mockReturnValueOnce(27)

    textarea.dispatchEvent(event)
    const result = handleLargeTextControlPasteEvent(event, {
      directMaxBytes: 2,
      maxBytes: 5,
      now,
      onPasteResult: pasteResult
    })

    expect(result).toEqual({ status: 'rejected', reason: 'too-large' })
    expect(event.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('safe')
    expect(pasteResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'rejected',
        reason: 'too-large',
        byteLength: 6,
        chunksWritten: 0,
        durationMs: 7,
        redactedDiagnostic: expect.stringContaining('content=redacted')
      })
    )
    expect(pasteResult.mock.calls[0]?.[0].redactedDiagnostic).toContain('durationMs=7')
    expect(pasteResult.mock.calls[0]?.[0].redactedDiagnostic).not.toContain('abcdef')
  })

  it('rejects oversized multibyte paste with a bounded byte measurement', () => {
    const textarea = appendTextarea('safe')
    textarea.focus()
    const pasteResult = vi.fn()
    const event = makePasteEvent('😀'.repeat(100))

    textarea.dispatchEvent(event)
    const result = handleLargeTextControlPasteEvent(event, {
      directMaxBytes: 2,
      maxBytes: 5,
      onPasteResult: pasteResult
    })

    expect(result).toEqual({ status: 'rejected', reason: 'too-large' })
    expect(event.defaultPrevented).toBe(true)
    expect(textarea.value).toBe('safe')
    expect(pasteResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'rejected',
        reason: 'too-large',
        byteLength: 8,
        chunksWritten: 0,
        redactedDiagnostic: expect.stringContaining('content=redacted')
      })
    )
    expect(pasteResult.mock.calls[0]?.[0].redactedDiagnostic).not.toContain('😀')
  })

  it('requires the event target to be the focused text control', () => {
    const focused = appendTextarea()
    const unfocused = appendTextarea()
    focused.focus()

    expect(findLargeTextControlPasteTarget(unfocused)).toBeNull()
  })

  it('installs a capture-phase listener that claims large paste before target handlers', async () => {
    const textarea = appendTextarea()
    textarea.focus()
    const cleanup = addLargeTextControlPasteListener(document, { directMaxBytes: 8 })
    const event = makePasteEvent('x'.repeat(128))
    const targetPaste = vi.fn()
    textarea.addEventListener('paste', targetPaste)

    textarea.dispatchEvent(event)
    cleanup()

    expect(event.defaultPrevented).toBe(true)
    expect(targetPaste).not.toHaveBeenCalled()
    await flushPromises()
    expect(textarea.value).toBe('x'.repeat(128))
  })
})
