// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  isNativeChatComposerCollapsed,
  setNativeChatComposerCollapsed,
  useNativeChatComposerCollapsed
} from './native-chat-composer-collapse-store'

describe('native chat composer collapse store', () => {
  it('shares one collapsed state per conversation and leaves others alone', () => {
    const first = renderHook(() => useNativeChatComposerCollapsed('chat-a'))
    const second = renderHook(() => useNativeChatComposerCollapsed('chat-a'))
    const other = renderHook(() => useNativeChatComposerCollapsed('chat-b'))

    act(() => first.result.current[1](true))
    expect(second.result.current[0]).toBe(true)
    expect(other.result.current[0]).toBe(false)

    act(() => setNativeChatComposerCollapsed('chat-a', false))
    expect(first.result.current[0]).toBe(false)
    expect(isNativeChatComposerCollapsed('chat-a')).toBe(false)
  })

  it('outlives the composers that showed it, like a tab switch', () => {
    const view = renderHook(() => useNativeChatComposerCollapsed('chat-c'))
    act(() => view.result.current[1](true))
    view.unmount()
    expect(renderHook(() => useNativeChatComposerCollapsed('chat-c')).result.current[0]).toBe(true)
    setNativeChatComposerCollapsed('chat-c', false)
  })
})
