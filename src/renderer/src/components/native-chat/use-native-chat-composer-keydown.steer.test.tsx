// @vitest-environment happy-dom

// Cmd/Ctrl+Enter sends the draft the other way; Cmd/Ctrl+Shift+Enter steers the head card.

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ isMac: true }))
vi.mock('./native-chat-shortcut', () => ({
  isMacPlatform: () => platform.isMac
}))

import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'

function setup(
  steerHead?: () => boolean,
  composer: { draft?: string; hasAttachments?: boolean } = {}
) {
  const callbacks = {
    completePickerItem: vi.fn(),
    dispatchPickerCommand: vi.fn(),
    dismissPicker: vi.fn(),
    interrupt: vi.fn(),
    send: vi.fn(),
    setActiveSuggestion: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn()
  }
  const hook = renderHook(() =>
    useNativeChatComposerKeyDown({
      autocomplete: { mode: 'none' as const },
      mentionFiles: { files: [], loading: false, failed: false },
      completeMention: vi.fn(),
      activeSuggestion: 0,
      draft: composer.draft ?? '',
      hasAttachments: composer.hasAttachments ?? false,
      isComposing: () => false,
      ...(steerHead ? { steerHead } : {}),
      ...callbacks
    })
  )
  return { handler: hook.result.current, callbacks }
}

function enter(
  modifiers: Partial<{
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    repeat: boolean
  }> = {}
) {
  return {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    keyCode: 0,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    ...modifiers
  }
}

type Handler = ReturnType<typeof useNativeChatComposerKeyDown>

function press(handler: Handler, event: ReturnType<typeof enter>): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only key, modifiers, repeat, keyCode, nativeEvent and preventDefault, all present on this stub.
  handler(event as unknown as Parameters<Handler>[0])
}

describe('composer send and steer chords', () => {
  it('⌘+Enter with text or an image sends it the other way', () => {
    platform.isMac = true
    const typed = setup(undefined, { draft: 'typed text' })
    press(typed.handler, enter({ metaKey: true }))
    expect(typed.callbacks.send).toHaveBeenCalledExactlyOnceWith({ alternate: true })
    const image = setup(undefined, { hasAttachments: true })
    press(image.handler, enter({ metaKey: true }))
    expect(image.callbacks.send).toHaveBeenCalledExactlyOnceWith({ alternate: true })
  })

  it('⌘+Enter on an empty composer does nothing', () => {
    platform.isMac = true
    const steerHead = vi.fn(() => true)
    const { handler, callbacks } = setup(steerHead)
    const event = enter({ metaKey: true })
    press(handler, event)
    expect(callbacks.send).not.toHaveBeenCalled()
    expect(steerHead).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('⌘+Shift+Enter steers the head card and leaves the draft', () => {
    platform.isMac = true
    const steerHead = vi.fn(() => true)
    const { handler, callbacks } = setup(steerHead, { draft: 'still typing' })
    const event = enter({ metaKey: true, shiftKey: true })
    press(handler, event)
    expect(steerHead).toHaveBeenCalledTimes(1)
    expect(callbacks.send).not.toHaveBeenCalled()
    expect(callbacks.setDraft).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
    // Holding the chord steers once, not each card that becomes the head.
    const held = enter({ metaKey: true, shiftKey: true, repeat: true })
    press(handler, held)
    expect(steerHead).toHaveBeenCalledTimes(1)
    expect(held.preventDefault).toHaveBeenCalled()
  })

  it('Ctrl — not ⌘ — is the modifier off Mac', () => {
    platform.isMac = false
    const steerHead = vi.fn(() => true)
    const { handler, callbacks } = setup(steerHead, { draft: 'typed text' })
    press(handler, enter({ metaKey: true }))
    expect(callbacks.send).toHaveBeenLastCalledWith()
    press(handler, enter({ ctrlKey: true }))
    expect(callbacks.send).toHaveBeenLastCalledWith({ alternate: true })
    press(handler, enter({ ctrlKey: true, shiftKey: true }))
    expect(steerHead).toHaveBeenCalledTimes(1)
  })

  it('plain Enter sends per the setting, and Shift+Enter still adds a newline', () => {
    platform.isMac = true
    const steerHead = vi.fn(() => true)
    const { handler, callbacks } = setup(steerHead, { draft: 'typed text' })
    press(handler, enter())
    expect(callbacks.send).toHaveBeenCalledExactlyOnceWith()
    const newline = enter({ shiftKey: true })
    press(handler, newline)
    expect(newline.preventDefault).not.toHaveBeenCalled()
    expect(steerHead).not.toHaveBeenCalled()
    expect(callbacks.send).toHaveBeenCalledTimes(1)
  })
})
