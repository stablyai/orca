// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'

import {
  TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES,
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  TEXT_CONTROL_PASTE_MAX_BYTES
} from '@/lib/text-control-paste'
import { insertText } from './dictation-insertion-target'

type DocumentWithExecCommand = Document & {
  execCommand?: (commandId: string, showUi?: boolean, value?: string) => boolean
}

const originalExecCommand = (document as DocumentWithExecCommand).execCommand

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: originalExecCommand
  })
})

function appendTextarea(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  document.body.appendChild(textarea)
  textarea.focus()
  return textarea
}

function appendContentEditable(): HTMLElement {
  const element = document.createElement('div')
  element.contentEditable = 'true'
  element.tabIndex = 0
  document.body.appendChild(element)
  element.focus()
  return element
}

function installExecCommandMock(
  implementation: (commandId: string, showUi?: boolean, value?: string) => boolean
): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn(implementation)
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: execCommand
  })
  return execCommand
}

describe('dictation insertion target', () => {
  it('chunks large textarea dictation without one large input event', async () => {
    vi.useFakeTimers()
    const textarea = appendTextarea()
    const inputEvents: InputEvent[] = []
    textarea.addEventListener('input', (event) => inputEvents.push(event as InputEvent))
    const text = 'a'.repeat(TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES + 5)

    insertText(text, { kind: 'text', element: textarea })
    await vi.runAllTimersAsync()

    expect(textarea.value).toBe(text)
    expect(inputEvents).toHaveLength(1)
    expect(inputEvents[0].inputType).toBe('insertText')
    expect(inputEvents[0].data ?? '').toBe('')
  })

  it('chunks large contenteditable dictation through bounded insertText calls', async () => {
    vi.useFakeTimers()
    const editor = appendContentEditable()
    const beforeInputEvents: InputEvent[] = []
    editor.addEventListener('beforeinput', (event) => beforeInputEvents.push(event as InputEvent))
    const execCommand = installExecCommandMock(() => true)
    const text = 'ab\u{1f600}'.repeat(20_000)

    insertText(text, { kind: 'contentEditable', element: editor })
    await vi.runAllTimersAsync()

    expect(execCommand.mock.calls.length).toBeGreaterThan(1)
    expect(
      execCommand.mock.calls.every(
        (call) => getUtf8ByteLength(String(call[2] ?? '')) <= TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES
      )
    ).toBe(true)
    expect(beforeInputEvents).toHaveLength(execCommand.mock.calls.length)
    expect(beforeInputEvents.some((event) => event.data === text)).toBe(false)
  })

  it('cancels chunked contenteditable dictation when the target disconnects', async () => {
    vi.useFakeTimers()
    const editor = appendContentEditable()
    const execCommand = installExecCommandMock(() => {
      editor.remove()
      return true
    })
    const text = 'x'.repeat(TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES + 1)

    insertText(text, { kind: 'contentEditable', element: editor })
    await vi.runAllTimersAsync()

    expect(execCommand).toHaveBeenCalledTimes(1)
  })

  it('rejects oversized multibyte contenteditable dictation before inserting', async () => {
    vi.useFakeTimers()
    const editor = appendContentEditable()
    const beforeInputEvents: InputEvent[] = []
    editor.addEventListener('beforeinput', (event) => beforeInputEvents.push(event as InputEvent))
    const execCommand = installExecCommandMock(() => true)
    const text = '😀'.repeat(Math.floor(TEXT_CONTROL_PASTE_MAX_BYTES / 4) + 1)

    insertText(text, { kind: 'contentEditable', element: editor })
    await vi.runAllTimersAsync()

    expect(execCommand).not.toHaveBeenCalled()
    expect(beforeInputEvents).toHaveLength(0)
    expect(editor.textContent).toBe('')
  })
})
