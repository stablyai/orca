// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_MENU_PASTE_EVENT,
  dispatchAppMenuPasteEvent,
  handleAppMenuPasteRequest
} from './app-menu-paste'

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

describe('app menu paste', () => {
  it('lets an owned terminal paste event claim the menu action synchronously', async () => {
    const readClipboardText = vi.fn(async () => 'secret')
    const performNativePaste = vi.fn()
    const onPaste = (event: Event): void => {
      event.preventDefault()
    }
    window.addEventListener(APP_MENU_PASTE_EVENT, onPaste)

    const result = await handleAppMenuPasteRequest({
      readClipboardText,
      performNativePaste
    })

    window.removeEventListener(APP_MENU_PASTE_EVENT, onPaste)
    expect(result).toEqual({ status: 'handled', target: 'terminal' })
    expect(readClipboardText).not.toHaveBeenCalled()
    expect(performNativePaste).not.toHaveBeenCalled()
  })

  it('falls back to native paste when no Orca-owned target is focused', async () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    const performNativePaste = vi.fn()

    const result = await handleAppMenuPasteRequest({
      readClipboardText: vi.fn(async () => 'text'),
      performNativePaste,
      dispatchOwnedPasteEvent: () => false
    })

    expect(result).toEqual({ status: 'native-fallback', reason: 'no-owned-target' })
    expect(performNativePaste).toHaveBeenCalledWith({ mode: 'paste' })
  })

  it('preserves paste-and-match-style when falling back to native paste', async () => {
    const performNativePaste = vi.fn()

    const result = await handleAppMenuPasteRequest({
      readClipboardText: vi.fn(async () => 'text'),
      performNativePaste,
      dispatchOwnedPasteEvent: () => false,
      getActiveElement: () => null,
      nativePasteMode: 'paste-and-match-style'
    })

    expect(result).toEqual({ status: 'native-fallback', reason: 'no-owned-target' })
    expect(performNativePaste).toHaveBeenCalledWith({ mode: 'paste-and-match-style' })
  })

  it('pastes large clipboard text into a focused text control without leaking event data', async () => {
    const textarea = appendTextarea('prefix ')
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const events = captureInputEvents(textarea)
    const text = 'secret-token '.repeat(6_000)

    const readClipboardText = vi.fn(async () => text)

    const result = await handleAppMenuPasteRequest({
      readClipboardText,
      performNativePaste: vi.fn(),
      dispatchOwnedPasteEvent: () => false
    })

    expect(result).toEqual({ status: 'handled', target: 'text-control' })
    expect(textarea.value).toBe(`prefix ${text}`)
    expect(events).toHaveLength(1)
    expect(events[0].inputType).toBe('insertFromPaste')
    expect(events[0].data ?? '').toBe('')
    expect(readClipboardText).toHaveBeenCalledWith({ maxBytes: 16 * 1024 * 1024 })
  })

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

  it('falls back to native paste when clipboard text cannot be read', async () => {
    const textarea = appendTextarea()
    textarea.focus()
    const performNativePaste = vi.fn()

    const result = await handleAppMenuPasteRequest({
      readClipboardText: vi.fn(async () => {
        throw new Error('clipboard denied')
      }),
      performNativePaste,
      dispatchOwnedPasteEvent: () => false
    })

    expect(result).toEqual({ status: 'native-fallback', reason: 'clipboard-read-failed' })
    expect(performNativePaste).toHaveBeenCalledWith({ mode: 'paste' })
  })

  it('does not native-fallback when clipboard read fails after focus moves', async () => {
    const textarea = appendTextarea('unchanged')
    const other = appendTextarea('other')
    textarea.focus()
    const performNativePaste = vi.fn()

    const result = await handleAppMenuPasteRequest({
      readClipboardText: vi.fn(async () => {
        other.focus()
        throw new Error('clipboard denied')
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
    expect(textarea.value).toBe('unchanged')
    expect(other.value).toBe('other')
    expect(performNativePaste).not.toHaveBeenCalled()
  })

  it('rejects oversized focused text-control paste without native fallback', async () => {
    const textarea = appendTextarea('unchanged')
    textarea.focus()
    const performNativePaste = vi.fn()

    const result = await handleAppMenuPasteRequest({
      readClipboardText: vi.fn(async () => {
        throw new Error('Clipboard text is too large for this paste target.')
      }),
      performNativePaste,
      dispatchOwnedPasteEvent: () => false
    })

    expect(result).toMatchObject({
      status: 'rejected',
      target: 'text-control',
      reason: 'too-large'
    })
    expect(result.status === 'rejected' ? result.redactedDiagnostic : '').toContain(
      'reason=too-large'
    )
    expect(result.status === 'rejected' ? result.redactedDiagnostic : '').toContain('durationMs=')
    expect(result.status === 'rejected' ? result.redactedDiagnostic : '').toContain(
      'content=redacted'
    )
    expect(textarea.value).toBe('unchanged')
    expect(performNativePaste).not.toHaveBeenCalled()
  })

  it('exposes a cancellable ownership event', () => {
    const onPaste = (event: Event): void => {
      event.preventDefault()
    }
    window.addEventListener(APP_MENU_PASTE_EVENT, onPaste)

    expect(dispatchAppMenuPasteEvent()).toBe(true)

    window.removeEventListener(APP_MENU_PASTE_EVENT, onPaste)
  })
})
