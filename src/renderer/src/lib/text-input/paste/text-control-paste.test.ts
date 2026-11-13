// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { pasteTextIntoTextControl } from './text-control-paste'

function appendTextarea(value = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.value = value
  document.body.appendChild(textarea)
  return textarea
}

function captureInputEvents(target: HTMLElement): InputEvent[] {
  const events: InputEvent[] = []
  target.addEventListener('input', (event) => {
    events.push(event as InputEvent)
  })
  return events
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('text control paste', () => {
  it('cancels a chunked paste when the target stops being valid', async () => {
    const textarea = appendTextarea()
    const events = captureInputEvents(textarea)
    let canContinue = true
    const text = 'abcdefghij'.repeat(3)

    const result = await pasteTextIntoTextControl(textarea, text, {
      directMaxBytes: 4,
      chunkMaxBytes: 5,
      canContinue: () => canContinue,
      yieldToEventLoop: async () => {
        canContinue = false
      }
    })

    expect(result).toMatchObject({
      status: 'cancelled',
      reason: 'target-unavailable',
      byteLength: text.length,
      chunksWritten: 1
    })
    expect(result.redactedDiagnostic).toContain('status=cancelled')
    expect(result.redactedDiagnostic).toContain('lines=1')
    expect(result.redactedDiagnostic).toContain('controls=false')
    expect(result.redactedDiagnostic).not.toContain(text)
    expect(textarea.value).toBe('abcde')
    expect(events).toHaveLength(1)
    expect(events[0].data ?? '').toBe('')
  })

  it('rejects oversized multibyte payloads after yielded preflight without mutating', async () => {
    const textarea = appendTextarea('safe')
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const events = captureInputEvents(textarea)
    const valuesObservedDuringYield: string[] = []
    const yieldToEventLoop = vi.fn(async () => {
      valuesObservedDuringYield.push(textarea.value)
    })

    const result = await pasteTextIntoTextControl(textarea, 'é'.repeat(8), {
      directMaxBytes: 2,
      maxBytes: 13,
      measureYieldAfterCodeUnits: 4,
      yieldToEventLoop
    })

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'too-large',
      byteLength: 14,
      chunksWritten: 0
    })
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(valuesObservedDuringYield).toEqual(['safe'])
    expect(textarea.value).toBe('safe')
    expect(events).toHaveLength(0)
  })
})
