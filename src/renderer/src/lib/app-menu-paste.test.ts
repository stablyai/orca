// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { APP_MENU_PASTE_EVENT, handleAppMenuPasteRequest } from './app-menu-paste'
import { addLargeTextControlPasteListener } from './large-text-control-paste'
import type { TextControlPasteResult } from './text-control-paste'

let removePasteListener: (() => void) | undefined

function appendTextarea(value = ''): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.value = value
  document.body.appendChild(textarea)
  textarea.focus()
  return textarea
}

afterEach(() => {
  removePasteListener?.()
  removePasteListener = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('app menu paste', () => {
  it('lets an owned terminal paste event claim the menu action synchronously', () => {
    const performNativePaste = vi.fn()
    const onPaste = (event: Event): void => event.preventDefault()
    window.addEventListener(APP_MENU_PASTE_EVENT, onPaste)
    let result: ReturnType<typeof handleAppMenuPasteRequest>
    try {
      result = handleAppMenuPasteRequest({ performNativePaste })
    } finally {
      window.removeEventListener(APP_MENU_PASTE_EVENT, onPaste)
    }
    expect(result).toEqual({ status: 'handled', target: 'terminal' })
    expect(performNativePaste).not.toHaveBeenCalled()
  })

  it.each(['paste', 'paste-and-match-style'] as const)(
    'requests native %s synchronously and preserves the text selection',
    async (mode) => {
      const textarea = appendTextarea('before old after')
      textarea.setSelectionRange(7, 10)
      const user = userEvent.setup()
      const url = 'https://linear.app/acme/issue/STA-1234'
      let delivery: Promise<void> | undefined
      const performNativePaste = vi.fn(() => {
        delivery = user.paste(url)
      })

      const result = handleAppMenuPasteRequest({ performNativePaste, nativePasteMode: mode })

      expect(delivery).toBeDefined()
      expect(result).toEqual({ status: 'native-fallback', reason: 'no-owned-target' })
      expect(performNativePaste).toHaveBeenCalledExactlyOnceWith({ mode })
      await delivery
      expect(textarea.value).toBe(`before ${url} after`)
      expect(textarea.selectionStart).toBe(7 + url.length)
      expect(textarea.selectionEnd).toBe(7 + url.length)
    }
  )

  it('keeps native paste events available to image handlers', async () => {
    const textarea = appendTextarea('unchanged')
    const image = new File(['image'], 'pasted.png', { type: 'image/png' })
    const clipboard = new DataTransfer()
    clipboard.items.add(image)
    const images: File[] = []
    textarea.addEventListener('paste', (event) => {
      images.push(...(event.clipboardData?.files ?? []))
      event.preventDefault()
    })
    const user = userEvent.setup()
    let delivery: Promise<void> | undefined

    handleAppMenuPasteRequest({
      performNativePaste: () => {
        delivery = user.paste(clipboard)
      }
    })
    await delivery

    expect(images).toEqual([image])
    expect(textarea.value).toBe('unchanged')
  })

  it('chunks large text delivered by native paste and emits one redacted input event', async () => {
    const textarea = appendTextarea('prefix ')
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const inputEvents: InputEvent[] = []
    textarea.addEventListener('input', (event) => {
      if (event instanceof InputEvent) {
        inputEvents.push(event)
      }
    })
    const finished = Promise.withResolvers<TextControlPasteResult>()
    removePasteListener = addLargeTextControlPasteListener(document, {
      directMaxBytes: 8,
      chunkMaxBytes: 6,
      yieldToEventLoop: async () => {},
      onPasteResult: finished.resolve
    })
    const text = 'secret-token '.repeat(10)
    const user = userEvent.setup()
    let delivery: Promise<void> | undefined

    handleAppMenuPasteRequest({
      performNativePaste: () => {
        delivery = user.paste(text)
      }
    })
    await delivery
    const result = await finished.promise

    expect(result).toMatchObject({ status: 'pasted', mode: 'chunked' })
    expect(textarea.value).toBe(`prefix ${text}`)
    expect(inputEvents).toHaveLength(1)
    expect(inputEvents[0].inputType).toBe('insertFromPaste')
    expect(inputEvents[0].data ?? '').toBe('')
  })

  it('rejects oversized native paste before changing the input', async () => {
    const textarea = appendTextarea('unchanged')
    const finished = Promise.withResolvers<TextControlPasteResult>()
    removePasteListener = addLargeTextControlPasteListener(document, {
      directMaxBytes: 2,
      maxBytes: 5,
      onPasteResult: finished.resolve
    })
    const user = userEvent.setup()
    let delivery: Promise<void> | undefined

    handleAppMenuPasteRequest({
      performNativePaste: () => {
        delivery = user.paste('secret-token')
      }
    })
    await delivery
    const result = await finished.promise

    expect(result).toMatchObject({ status: 'rejected', reason: 'too-large' })
    expect(result.redactedDiagnostic).toContain('content=redacted')
    expect(result.redactedDiagnostic).not.toContain('secret-token')
    expect(textarea.value).toBe('unchanged')
  })
})
