// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DICTATION_SUBMIT_EVENT } from '../dictation/dictation-auto-send'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useNativeChatDictationSubmit } from './use-native-chat-dictation-submit'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function composerInput(editor: HTMLElement): { current: NativeChatComposerInput } {
  const input: NativeChatComposerInput = {
    value: editor.textContent ?? '',
    selectionStart: 0,
    selectionEnd: 0,
    disabled: false,
    focus: () => editor.focus(),
    select: () => {},
    setSelectionRange: () => {},
    contains: (node) => editor.contains(node)
  }
  return { current: input }
}

function appendEditor(): HTMLElement {
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  document.body.appendChild(editor)
  return editor
}

function submit(element: HTMLElement): void {
  document.dispatchEvent(new CustomEvent(DICTATION_SUBMIT_EVENT, { detail: { element } }))
}

describe('useNativeChatDictationSubmit', () => {
  it('sends only from the composer that owns the dictated editor, with its latest send', () => {
    const firstEditor = appendEditor()
    const secondEditor = appendEditor()
    const staleSend = vi.fn()
    const latestSend = vi.fn()
    const otherSend = vi.fn()
    // Refs created once, as the composer's are: only `send` changes between renders.
    const firstInput = composerInput(firstEditor)
    const secondInput = composerInput(secondEditor)
    const first = renderHook(({ send }) => useNativeChatDictationSubmit(firstInput, send), {
      initialProps: { send: staleSend }
    })
    renderHook(() => useNativeChatDictationSubmit(secondInput, otherSend))

    first.rerender({ send: latestSend })
    submit(firstEditor)

    expect(latestSend).toHaveBeenCalledTimes(1)
    expect(staleSend).not.toHaveBeenCalled()
    expect(otherSend).not.toHaveBeenCalled()
  })
})
