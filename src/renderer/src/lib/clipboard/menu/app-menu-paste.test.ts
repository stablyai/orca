// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleAppMenuPasteRequest } from './app-menu-paste'

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

describe('app menu paste', () => {
  it('does not native-fallback after resolving a text control that loses focus', async () => {
    const textarea = appendTextarea('unchanged')
    const other = appendTextarea('other')
    textarea.focus()
    const performNativePaste = vi.fn()
    const text = 'secret-menu-token'

    const result = await handleAppMenuPasteRequest({
      readClipboardText: vi.fn(async () => {
        other.focus()
        return text
      }),
      performNativePaste,
      dispatchOwnedPasteEvent: () => false
    })

    expect(result).toMatchObject({
      status: 'rejected',
      target: 'text-control',
      reason: 'target-unavailable'
    })
    expect(result.status === 'rejected' ? result.redactedDiagnostic : '').toContain(
      'content=redacted'
    )
    expect(result.status === 'rejected' ? result.redactedDiagnostic : '').not.toContain(text)
    expect(textarea.value).toBe('unchanged')
    expect(other.value).toBe('other')
    expect(performNativePaste).not.toHaveBeenCalled()
  })
})
