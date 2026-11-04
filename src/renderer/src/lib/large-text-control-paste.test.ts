// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { addLargeTextControlPasteListener } from './large-text-control-paste'

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
