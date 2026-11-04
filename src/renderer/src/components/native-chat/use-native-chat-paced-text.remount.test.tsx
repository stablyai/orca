// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NativeChatReplyRevealsContext,
  type NativeChatReplyReveals
} from './native-chat-reply-reveals'
import { NATIVE_CHAT_TEXT_REVEAL_DELAY_MS as D } from '../../../../shared/native-chat/transcript/native-chat-text-reveal'
import { useNativeChatPacedText } from './use-native-chat-paced-text'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('@/hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => motion.reduced
}))

function transcript(): NativeChatReplyReveals {
  return { begun: new Set(['reply']), drawn: new Map() }
}
function within(reveals = transcript()) {
  return function Transcript({ children }: { children: ReactNode }) {
    return (
      <NativeChatReplyRevealsContext.Provider value={reveals}>
        {children}
      </NativeChatReplyRevealsContext.Provider>
    )
  }
}
function advance(ms: number): void {
  act(() => vi.advanceTimersByTime(ms))
}

beforeEach(() => {
  motion.reduced = false
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance'
    ]
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('fixed latency text reveal', () => {
  it('keeps the original deadline through a reconnect and remount', () => {
    const wrapper = within()
    const row = renderHook(() => useNativeChatPacedText('reply', 'a '.repeat(1000), true), {
      wrapper
    })
    advance(100)
    const shown = row.result.current.text.length
    expect(shown).toBeGreaterThan(0)
    expect(shown).toBeLessThan(2000)
    row.unmount()
    advance(200)
    const returned = renderHook(() => useNativeChatPacedText('reply', 'a '.repeat(1000), true), {
      wrapper
    })
    expect(returned.result.current.text.length).toBeGreaterThan(shown)
    advance(50)
    expect(returned.result.current.text).toHaveLength(2000)
  })

  it('shows text received while unmounted immediately rather than resetting its deadline', () => {
    const wrapper = within()
    const row = renderHook(() => useNativeChatPacedText('reply', 'a '.repeat(100), true), {
      wrapper
    })
    advance(50)
    row.unmount()
    advance(D)
    const returned = renderHook(() => useNativeChatPacedText('reply', 'a '.repeat(2000), true), {
      wrapper
    })
    expect(returned.result.current.text).toHaveLength(4000)
  })

  it('shows reduced-motion text immediately without fading or replay on remount', () => {
    motion.reduced = true
    const wrapper = within()
    const row = renderHook(() => useNativeChatPacedText('reply', 'a '.repeat(1000), true), {
      wrapper
    })
    expect(row.result.current.text).toHaveLength(2000)
    expect(row.result.current.fading).toBe(false)
    row.unmount()
    motion.reduced = false
    const returned = renderHook(() => useNativeChatPacedText('reply', 'a '.repeat(1000), true), {
      wrapper
    })
    expect(returned.result.current.text).toHaveLength(2000)
  })
})
