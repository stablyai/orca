// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  TEXT_CONTROL_PASTE_MAX_BYTES
} from '@/lib/text-control-paste'
import { captureInsertionTarget, insertText } from './dictation-insertion-target'

type DocumentWithExecCommand = Document & {
  execCommand?: (commandId: string, showUi?: boolean, value?: string) => boolean
}

const originalExecCommand = (document as DocumentWithExecCommand).execCommand

afterEach(() => {
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: originalExecCommand
  })
})

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
  it('sends text dictated into a focused browser page to that page', async () => {
    const insertDictationText = vi.fn(async () => true)
    vi.stubGlobal('api', { browser: { insertDictationText } })
    const viewport = document.createElement('div')
    viewport.dataset.browserPageViewportId = 'page-1'
    const guest = document.createElement('webview')
    guest.tabIndex = 0
    viewport.appendChild(guest)
    document.body.appendChild(viewport)
    guest.focus()

    const target = captureInsertionTarget()
    expect(target).toEqual({ kind: 'browser', browserPageId: 'page-1' })
    await expect(insertText('hello', target!)).resolves.toBe(true)

    expect(insertDictationText).toHaveBeenCalledWith({ browserPageId: 'page-1', text: 'hello' })
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
