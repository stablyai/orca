// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PASTE_PAYLOAD_CORPUS } from './paste-payload-corpus'
import {
  getTextControlPasteByteLength,
  measureTextControlPasteByteLength,
  pasteTextIntoTextControl,
  shouldHandleTextControlPaste
} from './text-control-paste'

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

function getPastePayloadCorpusText(name: string): string {
  const entry = PASTE_PAYLOAD_CORPUS.find((item) => item.name === name)
  if (!entry) {
    throw new Error(`Missing paste payload corpus case: ${name}`)
  }
  return entry.text
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('text control paste', () => {
  it('pastes small payloads directly and preserves the selection', async () => {
    const textarea = appendTextarea('hello world')
    textarea.setSelectionRange(6, 11)
    const events = captureInputEvents(textarea)
    const now = vi.fn()
    now.mockReturnValueOnce(5).mockReturnValueOnce(17)

    const result = await pasteTextIntoTextControl(textarea, 'cafe\nbye', { now })

    expect(result).toMatchObject({
      status: 'pasted',
      mode: 'direct',
      byteLength: 'cafe\nbye'.length,
      chunksWritten: 1,
      durationMs: 12
    })
    expect(result.redactedDiagnostic).toContain('content=redacted')
    expect(result.redactedDiagnostic).toContain('lines=2')
    expect(result.redactedDiagnostic).toContain('durationMs=12')
    expect(result.redactedDiagnostic).toContain('controls=false')
    expect(result.redactedDiagnostic).not.toContain('cafe')
    expect(textarea.value).toBe('hello cafe\nbye')
    expect(textarea.selectionStart).toBe('hello cafe\nbye'.length)
    expect(events).toHaveLength(1)
    expect(events[0].inputType).toBe('insertFromPaste')
    expect(events[0].data).toBe('cafe\nbye')
  })

  it('chunks large payloads and dispatches one privacy-safe input event', async () => {
    const textarea = appendTextarea('before:')
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const events = captureInputEvents(textarea)
    const yieldToEventLoop = vi.fn(async () => {})
    const text = 'ab😀cd\n'.repeat(6)

    const result = await pasteTextIntoTextControl(textarea, text, {
      directMaxBytes: 8,
      chunkMaxBytes: 10,
      yieldToEventLoop
    })

    if (result.status !== 'pasted') {
      throw new Error('Expected chunked paste to complete')
    }
    expect(result.mode).toBe('chunked')
    expect(result.chunksWritten).toBeGreaterThan(1)
    expect(result.redactedDiagnostic).toContain('lines=7')
    expect(result.redactedDiagnostic).toContain('controls=false')
    expect(yieldToEventLoop).toHaveBeenCalledTimes(result.chunksWritten - 1)
    expect(textarea.value).toBe(`before:${text}`)
    expect(events).toHaveLength(1)
    expect(events[0].inputType).toBe('insertFromPaste')
    expect(events[0].data ?? '').toBe('')
  })

  it('records control metadata in diagnostics without exposing pasted text', async () => {
    const textarea = appendTextarea()
    const text = `${getPastePayloadCorpusText('ANSI control sequence')} secret-token`

    const result = await pasteTextIntoTextControl(textarea, text)

    expect(result.status).toBe('pasted')
    expect(result.redactedDiagnostic).toContain('controls=true')
    expect(result.redactedDiagnostic).toContain('content=redacted')
    expect(result.redactedDiagnostic).not.toContain('secret-token')
    expect(result.redactedDiagnostic).not.toContain('before')
    expect(result.redactedDiagnostic).not.toContain('after')
    expect(textarea.value).toBe(text)
  })

  it('does not split surrogate pairs across chunks', async () => {
    const textarea = appendTextarea()
    const text = 'a😀b😀c'

    const result = await pasteTextIntoTextControl(textarea, text, {
      directMaxBytes: 2,
      chunkMaxBytes: 5,
      yieldToEventLoop: async () => {}
    })

    expect(result.status).toBe('pasted')
    expect(textarea.value).toBe(text)
  })

  it('rejects unavailable text controls without mutating them', async () => {
    const textarea = appendTextarea('unchanged')
    const disabled = appendTextarea('disabled')
    disabled.disabled = true

    const disconnectedResult = await pasteTextIntoTextControl(textarea, 'text', {
      canContinue: () => false
    })
    const disabledResult = await pasteTextIntoTextControl(disabled, 'text')

    expect(disconnectedResult).toMatchObject({
      status: 'rejected',
      reason: 'target-unavailable',
      byteLength: 4,
      chunksWritten: 0
    })
    expect(disabledResult.status).toBe('rejected')
    expect(textarea.value).toBe('unchanged')
    expect(disabled.value).toBe('disabled')
  })

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

  it('rejects oversized payloads before mutating the control', async () => {
    const textarea = appendTextarea('safe')
    const events = captureInputEvents(textarea)
    const now = vi.fn()
    now.mockReturnValueOnce(10).mockReturnValueOnce(15)

    const result = await pasteTextIntoTextControl(textarea, 'abcdef', {
      maxBytes: 5,
      now
    })

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'too-large',
      byteLength: 6,
      chunksWritten: 0,
      durationMs: 5
    })
    expect(result.redactedDiagnostic).toContain('reason=too-large')
    expect(result.redactedDiagnostic).toContain('durationMs=5')
    expect(result.redactedDiagnostic).toContain('lines=1')
    expect(result.redactedDiagnostic).toContain('controls=false')
    expect(result.redactedDiagnostic).not.toContain('abcdef')
    expect(textarea.value).toBe('safe')
    expect(events).toHaveLength(0)
  })

  it('yields while measuring large payloads before mutating the control', async () => {
    const textarea = appendTextarea('safe')
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const valuesObservedDuringYield: string[] = []
    const yieldToEventLoop = vi.fn(async () => {
      valuesObservedDuringYield.push(textarea.value)
    })

    const result = await pasteTextIntoTextControl(textarea, 'abcdefghij', {
      chunkMaxBytes: 64,
      directMaxBytes: 2,
      maxBytes: 64,
      measureYieldAfterCodeUnits: 4,
      yieldToEventLoop
    })

    expect(result.status).toBe('pasted')
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(valuesObservedDuringYield[0]).toBe('safe')
    expect(textarea.value).toBe('safeabcdefghij')
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

  it('uses utf-8 byte thresholds for non-ascii text', () => {
    expect(getTextControlPasteByteLength('a😀é')).toBe(7)
    expect(shouldHandleTextControlPaste('😀😀', { directMaxBytes: 7 })).toBe(true)
    expect(shouldHandleTextControlPaste('abc', { directMaxBytes: 7 })).toBe(false)
    expect(shouldHandleTextControlPaste('', { directMaxBytes: 0 })).toBe(false)
  })

  it('can stop measuring text-control paste once the limit is exceeded', () => {
    const measurement = measureTextControlPasteByteLength('😀'.repeat(100), {
      stopAfterBytes: 5
    })

    expect(measurement).toEqual({ byteLength: 8, exceededLimit: true })
    expect(measurement.byteLength).toBeLessThan(getTextControlPasteByteLength('😀'.repeat(100)))
  })
})
