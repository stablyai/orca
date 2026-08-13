// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatAcceptMention } from './use-native-chat-mention-accept'
import type { ComposerAutocomplete } from './native-chat-composer-state'

describe('useNativeChatAcceptMention', () => {
  it('replaces the mention query with the chosen path and moves the caret past it', () => {
    const setDraft = vi.fn()
    const setCaret = vi.fn()
    const textareaRef = { current: document.createElement('textarea') }
    const focusSpy = vi.spyOn(textareaRef.current, 'focus')
    const autocomplete: ComposerAutocomplete = { mode: 'mention', query: 'read' }
    const { result } = renderHook(() =>
      useNativeChatAcceptMention({
        autocomplete,
        draft: 'see @read',
        caret: 9,
        setDraft,
        setCaret,
        textareaRef
      })
    )

    act(() => result.current())

    expect(setDraft).toHaveBeenCalledWith('see @read ')
    expect(setCaret).toHaveBeenCalledWith('see @read '.length)
    expect(focusSpy).toHaveBeenCalledOnce()
  })

  it('does nothing when no mention is active', () => {
    const setDraft = vi.fn()
    const setCaret = vi.fn()
    const textareaRef = { current: document.createElement('textarea') }
    const autocomplete: ComposerAutocomplete = { mode: 'none' }
    const { result } = renderHook(() =>
      useNativeChatAcceptMention({
        autocomplete,
        draft: 'hello',
        caret: 5,
        setDraft,
        setCaret,
        textareaRef
      })
    )

    act(() => result.current())

    expect(setDraft).not.toHaveBeenCalled()
    expect(setCaret).not.toHaveBeenCalled()
  })
})
