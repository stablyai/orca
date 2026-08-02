// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findEditablePrimarySelectionPasteTarget,
  pastePrimarySelectionTextIntoTarget
} from './primary-selection-paste'

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

function appendContentEditable(text = ''): HTMLDivElement {
  const element = document.createElement('div')
  element.contentEditable = 'true'
  element.textContent = text
  document.body.appendChild(element)

  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return element
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'execCommand')
  Reflect.deleteProperty(document, 'queryCommandSupported')
})

describe('primary selection paste', () => {
  it('pastes into the resolved text control target', async () => {
    const textarea = appendTextarea('alpha omega')
    textarea.focus()
    textarea.setSelectionRange(6, 11)

    const target = findEditablePrimarySelectionPasteTarget(textarea)
    const result = await pastePrimarySelectionTextIntoTarget(target!, 'beta', {
      clientX: 0,
      clientY: 0
    })

    expect(target).toBe(textarea)
    expect(result).toBe(true)
    expect(textarea.value).toBe('alpha beta')
  })

  it('does not resolve disabled or terminal helper textareas as paste targets', () => {
    const disabled = appendTextarea()
    disabled.disabled = true
    const terminalRoot = document.createElement('div')
    terminalRoot.className = 'xterm-helper-textarea'
    const terminalTextarea = document.createElement('textarea')
    terminalRoot.appendChild(terminalTextarea)
    document.body.appendChild(terminalRoot)

    expect(findEditablePrimarySelectionPasteTarget(disabled)).toBeNull()
    expect(findEditablePrimarySelectionPasteTarget(terminalTextarea)).toBeNull()
  })

  it('routes large text-control pastes through chunked insertion without event data leakage', async () => {
    const textarea = appendTextarea()
    textarea.focus()
    const events = captureInputEvents(textarea)
    const text = 'secret-token '.repeat(6_000)

    const result = await pastePrimarySelectionTextIntoTarget(textarea, text, {
      clientX: 0,
      clientY: 0
    })

    expect(result).toBe(true)
    expect(textarea.value).toBe(text)
    expect(events).toHaveLength(1)
    expect(events[0].inputType).toBe('insertFromPaste')
    expect(events[0].data ?? '').toBe('')
  })

  it('rejects stale text-control targets', async () => {
    const textarea = document.createElement('textarea')
    textarea.value = 'unchanged'

    const result = await pastePrimarySelectionTextIntoTarget(textarea, 'text', {
      clientX: 0,
      clientY: 0
    })

    expect(result).toBe(false)
    expect(textarea.value).toBe('unchanged')
  })

  it('rejects connected text-control targets that lost focus', async () => {
    const textarea = appendTextarea('unchanged')
    const other = appendTextarea('other')
    other.focus()

    const result = await pastePrimarySelectionTextIntoTarget(textarea, 'text', {
      clientX: 0,
      clientY: 0
    })

    expect(result).toBe(false)
    expect(textarea.value).toBe('unchanged')
    expect(document.activeElement).toBe(other)
  })

  it('stops chunked text-control paste when focus leaves the target', async () => {
    const textarea = appendTextarea()
    const other = appendTextarea('other')
    textarea.focus()
    const events = captureInputEvents(textarea)
    const text = 'secret-token '.repeat(24)
    const yieldToEventLoop = vi.fn(async () => {
      other.focus()
    })

    const result = await pastePrimarySelectionTextIntoTarget(
      textarea,
      text,
      {
        clientX: 0,
        clientY: 0
      },
      {
        chunkMaxBytes: 13,
        directMaxBytes: 32,
        yieldToEventLoop
      }
    )

    expect(result).toBe(false)
    expect(textarea.value).not.toBe(text)
    expect(other.value).toBe('other')
    expect(document.activeElement).toBe(other)
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0].inputType).toBe('insertFromPaste')
    expect(events[0].data ?? '').toBe('')
  })

  it('pastes large contenteditable text in chunks without event data leakage', async () => {
    const target = appendContentEditable('prefix ')
    const events = captureInputEvents(target)
    const execCommand = vi.fn(() => {
      throw new Error('large contenteditable paste must not use execCommand')
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    Object.defineProperty(document, 'queryCommandSupported', {
      configurable: true,
      value: vi.fn(() => true)
    })
    const yieldToEventLoop = vi.fn(async () => {})
    const text = 'secret-token '.repeat(24)

    const result = await pastePrimarySelectionTextIntoTarget(
      target,
      text,
      {
        clientX: 0,
        clientY: 0
      },
      {
        chunkMaxBytes: 13,
        directMaxBytes: 32,
        yieldToEventLoop
      }
    )

    expect(result).toBe(true)
    expect(target.textContent).toBe(`prefix ${text}`)
    expect(execCommand).not.toHaveBeenCalled()
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0].inputType).toBe('insertFromPaste')
    expect(events[0].data ?? '').toBe('')
  })

  it('plans contenteditable chunks without slicing every code point', async () => {
    const target = appendContentEditable('prefix ')
    const slice = vi.spyOn(String.prototype, 'slice')
    const text = 'x'.repeat(128)

    const result = await pastePrimarySelectionTextIntoTarget(
      target,
      text,
      {
        clientX: 0,
        clientY: 0
      },
      {
        chunkMaxBytes: 8,
        directMaxBytes: 4
      }
    )

    expect(result).toBe(true)
    expect(target.textContent).toBe(`prefix ${text}`)
    expect(slice.mock.calls.length).toBeLessThan(text.length)
  })

  it('yields during large contenteditable preflight before inserting primary-selection text', async () => {
    const target = appendContentEditable('prefix ')
    const yieldToEventLoop = vi.fn(async () => {})
    const text = 'x'.repeat(32)

    const pastePromise = pastePrimarySelectionTextIntoTarget(
      target,
      text,
      {
        clientX: 0,
        clientY: 0
      },
      {
        chunkMaxBytes: 64,
        directMaxBytes: 4,
        maxBytes: 64,
        measureYieldAfterCodeUnits: 8,
        yieldToEventLoop
      }
    )

    expect(target.textContent).toBe('prefix ')

    await expect(pastePromise).resolves.toBe(true)

    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(target.textContent).toBe(`prefix ${text}`)
  })

  it('stops chunked contenteditable paste when focus leaves the target', async () => {
    const target = appendContentEditable('prefix ')
    const other = appendTextarea('other')
    const events = captureInputEvents(target)
    const text = 'secret-token '.repeat(24)
    const yieldToEventLoop = vi.fn(async () => {
      other.focus()
    })

    const result = await pastePrimarySelectionTextIntoTarget(
      target,
      text,
      {
        clientX: 0,
        clientY: 0
      },
      {
        chunkMaxBytes: 13,
        directMaxBytes: 32,
        yieldToEventLoop
      }
    )

    expect(result).toBe(false)
    expect(target.textContent).not.toBe(`prefix ${text}`)
    expect(other.value).toBe('other')
    expect(events).toHaveLength(1)
    expect(events[0].inputType).toBe('insertFromPaste')
    expect(events[0].data ?? '').toBe('')
  })

  it('rejects oversized contenteditable primary-selection text before DOM insertion', async () => {
    const target = appendContentEditable('unchanged')
    const yieldToEventLoop = vi.fn(async () => {})

    const result = await pastePrimarySelectionTextIntoTarget(
      target,
      'secret-token',
      {
        clientX: 0,
        clientY: 0
      },
      {
        maxBytes: 4,
        yieldToEventLoop
      }
    )

    expect(result).toBe(false)
    expect(target.textContent).toBe('unchanged')
    expect(yieldToEventLoop).not.toHaveBeenCalled()
  })

  it('rejects oversized multibyte contenteditable primary-selection text with bounded measuring', async () => {
    const target = appendContentEditable('unchanged')
    const events = captureInputEvents(target)
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    Object.defineProperty(document, 'queryCommandSupported', {
      configurable: true,
      value: vi.fn(() => true)
    })

    const result = await pastePrimarySelectionTextIntoTarget(
      target,
      '😀'.repeat(10_000),
      {
        clientX: 0,
        clientY: 0
      },
      {
        maxBytes: 7
      }
    )

    expect(result).toBe(false)
    expect(target.textContent).toBe('unchanged')
    expect(execCommand).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
  })

  it('rejects oversized contenteditable text after yielded preflight without DOM insertion', async () => {
    const target = appendContentEditable('unchanged')
    const events = captureInputEvents(target)
    const yieldToEventLoop = vi.fn(async () => {})

    const result = await pastePrimarySelectionTextIntoTarget(
      target,
      'é'.repeat(8),
      {
        clientX: 0,
        clientY: 0
      },
      {
        directMaxBytes: 2,
        maxBytes: 13,
        measureYieldAfterCodeUnits: 4,
        yieldToEventLoop
      }
    )

    expect(result).toBe(false)
    expect(yieldToEventLoop).toHaveBeenCalled()
    expect(target.textContent).toBe('unchanged')
    expect(events).toHaveLength(0)
  })
})
