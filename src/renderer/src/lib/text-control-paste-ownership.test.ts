// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PASTE_PAYLOAD_CORPUS } from './paste-payload-corpus'
import { TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES } from './text-control-paste'
import {
  classifyTextControlPastePayloadOwnership,
  findOwnedPasteEventTextControlTarget,
  findOwnedTextControlPasteTarget,
  shouldClaimTextControlPastePayload
} from './text-control-paste-ownership'

function appendTextarea(value = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.value = value
  document.body.appendChild(textarea)
  return textarea
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('text control paste ownership', () => {
  it('resolves only focused editable text controls as owned paste targets', () => {
    const textarea = appendTextarea()
    const disabled = appendTextarea()
    disabled.disabled = true
    const readonly = appendTextarea()
    readonly.readOnly = true
    const colorInput = document.createElement('input')
    colorInput.type = 'color'
    document.body.appendChild(colorInput)
    textarea.focus()

    expect(findOwnedTextControlPasteTarget(textarea)).toBe(textarea)
    expect(findOwnedTextControlPasteTarget(disabled)).toBeNull()
    expect(findOwnedTextControlPasteTarget(readonly)).toBeNull()
    expect(findOwnedTextControlPasteTarget(colorInput)).toBeNull()
    expect(findOwnedTextControlPasteTarget(null)).toBeNull()
  })

  it('rejects paste-event ownership for terminal helper textareas or stale focus', () => {
    const textarea = appendTextarea()
    const other = appendTextarea()
    const terminalRoot = document.createElement('div')
    terminalRoot.className = 'xterm-helper-textarea'
    const terminalTextarea = document.createElement('textarea')
    terminalRoot.appendChild(terminalTextarea)
    document.body.appendChild(terminalRoot)
    textarea.focus()

    expect(findOwnedPasteEventTextControlTarget(textarea, textarea)).toBe(textarea)
    expect(findOwnedPasteEventTextControlTarget(other, textarea)).toBeNull()
    expect(findOwnedPasteEventTextControlTarget(terminalTextarea, terminalTextarea)).toBeNull()
  })

  it('allows native paste for empty and small payloads', () => {
    expect(classifyTextControlPastePayloadOwnership('')).toEqual({
      action: 'allow-native',
      reason: 'empty',
      byteLength: 0,
      exceededLimit: false
    })
    expect(classifyTextControlPastePayloadOwnership('small')).toEqual({
      action: 'allow-native',
      reason: 'small',
      byteLength: 5,
      exceededLimit: false
    })
    expect(shouldClaimTextControlPastePayload('small')).toBe(false)
  })

  it('keeps literal corpus text on the native path while it is below paste thresholds', () => {
    for (const { name, text } of PASTE_PAYLOAD_CORPUS) {
      expect(
        classifyTextControlPastePayloadOwnership(text, {
          directMaxBytes: 10_000,
          maxBytes: 20_000
        }),
        name
      ).toMatchObject({
        action: 'allow-native',
        exceededLimit: false
      })
    }
  })

  it('claims large text-control payloads with bounded ownership measuring', () => {
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const text = 'x'.repeat(TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES + 4_096)

    expect(classifyTextControlPastePayloadOwnership(text)).toMatchObject({
      action: 'claim-orca',
      exceededLimit: true
    })
    expect(codePointAt.mock.calls.length).toBeLessThanOrEqual(
      TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES + 1
    )
    codePointAt.mockClear()

    expect(shouldClaimTextControlPastePayload(text)).toBe(true)
    expect(codePointAt.mock.calls.length).toBeLessThanOrEqual(
      TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES + 1
    )
  })

  it('rejects oversized payloads before native paste can run', () => {
    expect(
      classifyTextControlPastePayloadOwnership('abcdef', {
        directMaxBytes: 2,
        maxBytes: 5
      })
    ).toEqual({
      action: 'reject',
      reason: 'too-large',
      byteLength: 6,
      exceededLimit: true
    })
    expect(
      classifyTextControlPastePayloadOwnership('😀'.repeat(100), {
        directMaxBytes: 2,
        maxBytes: 5
      })
    ).toEqual({
      action: 'reject',
      reason: 'too-large',
      byteLength: 8,
      exceededLimit: true
    })
  })
})
