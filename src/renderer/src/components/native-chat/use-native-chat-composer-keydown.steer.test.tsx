// @vitest-environment happy-dom

// Cmd/Ctrl+Enter in an empty composer: steer the newest queued draft when one
// exists; with nothing queued, or with text or images in the composer, the
// chord stays what it always was — a send.
// The primary modifier follows the platform (⌘ on Mac, Ctrl elsewhere).

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_HISTORY } from './native-chat-composer-state'

const platform = vi.hoisted(() => ({ isMac: true }))
vi.mock('./native-chat-shortcut', () => ({
  isMacPlatform: () => platform.isMac
}))

import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'

function setup(
  steerQueued?: () => boolean,
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
    setCaret: vi.fn(),
    setHistory: vi.fn()
  }
  const hook = renderHook(() =>
    useNativeChatComposerKeyDown({
      autocomplete: { mode: 'none' as const },
      activeSuggestion: 0,
      draft: composer.draft ?? '',
      hasAttachments: composer.hasAttachments ?? false,
      history: EMPTY_HISTORY,
      isComposing: () => false,
      matchesSubmitKey: (event) => event.key === 'Enter' && !event.shiftKey,
      ...(steerQueued ? { steerQueued } : {}),
      ...callbacks
    })
  )
  return { handler: hook.result.current, callbacks }
}

function enter(modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean }> = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    keyCode: 0,
    nativeEvent: { isComposing: false },
    preventDefault: vi.fn(),
    ...modifiers
  }
}

type Handler = ReturnType<typeof useNativeChatComposerKeyDown>

function press(handler: Handler, event: ReturnType<typeof enter>): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only key, modifiers, keyCode, nativeEvent and preventDefault, all present on this stub.
  handler(event as unknown as Parameters<Handler>[0])
}

describe('composer steer chord', () => {
  it('⌘+Enter on Mac steers the newest queued draft instead of sending', () => {
    platform.isMac = true
    const steerQueued = vi.fn(() => true)
    const { handler, callbacks } = setup(steerQueued)
    const event = enter({ metaKey: true })
    press(handler, event)
    expect(steerQueued).toHaveBeenCalledTimes(1)
    expect(callbacks.send).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('Ctrl — not ⌘ — is the chord off Mac', () => {
    platform.isMac = false
    const steerQueued = vi.fn(() => true)
    const { handler, callbacks } = setup(steerQueued)
    press(handler, enter({ metaKey: true }))
    expect(steerQueued).not.toHaveBeenCalled()
    expect(callbacks.send).toHaveBeenCalledTimes(1)
    press(handler, enter({ ctrlKey: true }))
    expect(steerQueued).toHaveBeenCalledTimes(1)
    expect(callbacks.send).toHaveBeenCalledTimes(1)
  })

  it('with nothing queued the chord falls through to a plain send', () => {
    platform.isMac = true
    const { handler, callbacks } = setup(vi.fn(() => false))
    press(handler, enter({ metaKey: true }))
    expect(callbacks.send).toHaveBeenCalledTimes(1)
  })

  it('with text or an image in the composer the chord sends it, never a card past it', () => {
    platform.isMac = true
    const steerQueued = vi.fn(() => true)
    const typed = setup(steerQueued, { draft: 'typed text' })
    press(typed.handler, enter({ metaKey: true }))
    expect(steerQueued).not.toHaveBeenCalled()
    expect(typed.callbacks.send).toHaveBeenCalledTimes(1)
    const image = setup(steerQueued, { hasAttachments: true })
    press(image.handler, enter({ metaKey: true }))
    expect(steerQueued).not.toHaveBeenCalled()
    expect(image.callbacks.send).toHaveBeenCalledTimes(1)
  })

  it('plain Enter never steers', () => {
    platform.isMac = true
    const steerQueued = vi.fn(() => true)
    const { handler, callbacks } = setup(steerQueued)
    press(handler, enter())
    expect(steerQueued).not.toHaveBeenCalled()
    expect(callbacks.send).toHaveBeenCalledTimes(1)
  })
})
