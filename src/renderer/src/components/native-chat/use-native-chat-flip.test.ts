// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_FLIP_MS, useNativeChatFlip } from './use-native-chat-flip'

function setReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

describe('useNativeChatFlip', () => {
  beforeEach(() => {
    setReducedMotion(false)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not animate a chat view that is already open on first render', () => {
    const { result } = renderHook(() => useNativeChatFlip(true))
    // Restored sessions and reloads must not replay the flip.
    expect(result.current.rendered).toBe(true)
  })

  it('flips in when the chat view is opened', () => {
    const { result, rerender } = renderHook(({ active }) => useNativeChatFlip(active), {
      initialProps: { active: false }
    })
    expect(result.current.rendered).toBe(false)

    rerender({ active: true })
    expect(result.current.rendered).toBe(true)
    expect(result.current.className).toBe('native-chat-flip-in')
  })

  it('holds the layer through the flip-out, then unmounts it', () => {
    const { result, rerender } = renderHook(({ active }) => useNativeChatFlip(active), {
      initialProps: { active: true }
    })

    rerender({ active: false })
    // Still rendered so the exit animation is visible over the terminal.
    expect(result.current.rendered).toBe(true)
    expect(result.current.className).toBe('native-chat-flip-out')

    act(() => {
      vi.advanceTimersByTime(NATIVE_CHAT_FLIP_MS)
    })
    expect(result.current.rendered).toBe(false)
  })

  it('lands open when re-opened mid flip-out', () => {
    const { result, rerender } = renderHook(({ active }) => useNativeChatFlip(active), {
      initialProps: { active: true }
    })
    rerender({ active: false })
    expect(result.current.className).toBe('native-chat-flip-out')

    rerender({ active: true })
    act(() => {
      vi.advanceTimersByTime(NATIVE_CHAT_FLIP_MS * 2)
    })
    // The cancelled exit must not strand the surface unmounted.
    expect(result.current.rendered).toBe(true)
    expect(result.current.className).toBe('native-chat-flip-in')
  })

  it('switches instantly with no class under prefers-reduced-motion', () => {
    setReducedMotion(true)
    const { result, rerender } = renderHook(({ active }) => useNativeChatFlip(active), {
      initialProps: { active: true }
    })
    expect(result.current.className).toBe('')

    rerender({ active: false })
    // No held-open exit: the terminal comes back immediately.
    expect(result.current.rendered).toBe(false)
    expect(result.current.className).toBe('')
  })

  it('survives an environment with no matchMedia', () => {
    // @ts-expect-error deliberately removing the API to prove the guard holds
    window.matchMedia = undefined
    const { result } = renderHook(() => useNativeChatFlip(true))
    expect(result.current.rendered).toBe(true)
  })
})
