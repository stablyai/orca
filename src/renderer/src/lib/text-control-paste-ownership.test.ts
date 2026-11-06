// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import './text-control-paste'
import {
  findOwnedPasteEventTextControlTarget,
  findOwnedTextControlPasteTarget
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
    expect(findOwnedTextControlPasteTarget(terminalTextarea)).toBeNull()
  })
})
