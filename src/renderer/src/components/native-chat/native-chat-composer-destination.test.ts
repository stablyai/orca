// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import {
  registerNativeChatComposerDestination,
  nativeChatComposerDestination
} from './native-chat-composer-destination'
import {
  captureInsertionTarget,
  insertText,
  registerDictationComposerTarget
} from '../dictation/dictation-insertion-target'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

function handle(): NativeChatComposerHandle {
  return {
    focus: vi.fn(() => true),
    insertTypedText: vi.fn(() => true),
    acceptsText: vi.fn(() => true),
    appendText: vi.fn(),
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn(),
    contains: vi.fn(() => true)
  }
}
it('routes between two composers by focus, survives disabled-handle replacement and identity cleanup, and captures dictation', () => {
  const pane = document.createElement('div')
  const bottom = document.createElement('div')
  const edit = document.createElement('div')
  const bottomInput = document.createElement('textarea')
  const editInput = document.createElement('textarea')
  bottom.append(bottomInput)
  edit.append(editInput)
  pane.append(bottom, edit)
  document.body.append(pane)
  const bottomRef = { current: handle() }
  const editRef = { current: handle() }
  const releaseBottom = registerNativeChatComposerDestination(bottom, bottomRef, true)
  const releaseEdit = registerNativeChatComposerDestination(edit, editRef, false)
  const transcript = vi.fn()
  const releaseDictation = registerDictationComposerTarget(edit, transcript)
  try {
    expect(nativeChatComposerDestination(pane, null)).toBe(bottomRef.current)
    editInput.focus()
    expect(nativeChatComposerDestination(pane, null)).toBe(editRef.current)
    const captured = captureInsertionTarget()
    bottomInput.focus()
    expect(nativeChatComposerDestination(pane, null)).toBe(bottomRef.current)
    editInput.focus()
    editRef.current = handle()
    expect(nativeChatComposerDestination(pane, null)).toBe(editRef.current)
    const replacement = { current: handle() }
    const releaseReplacement = registerNativeChatComposerDestination(edit, replacement, false)
    releaseEdit()
    editInput.focus()
    edit.dispatchEvent(new Event('pointerdown'))
    expect(nativeChatComposerDestination(pane, null)).toBe(replacement.current)
    releaseReplacement()
    releaseDictation()
    edit.remove()
    expect(nativeChatComposerDestination(pane, null)).toBe(bottomRef.current)
    expect(captured?.kind).toBe('composer')
    if (captured) {
      insertText('late transcript', captured)
    }
    expect(transcript).toHaveBeenCalledExactlyOnceWith('late transcript')
  } finally {
    releaseBottom()
    releaseEdit()
    releaseDictation()
    pane.remove()
  }
})
