// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NativeChatReplyRevealsContext,
  type NativeChatReplyReveals
} from './native-chat-reply-reveals'
import { NATIVE_CHAT_TEXT_REVEAL_DELAY_MS as D } from './native-chat-text-reveal'
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
  it.each([
    {
      chunks: [
        [0, 80],
        [70, 20],
        [150, 2000],
        [490, 100]
      ]
    },
    { chunks: [[0, 100_000]] },
    {
      chunks: [
        [0, 2000],
        [D - 1, 2000],
        [D + 20, 2000]
      ]
    }
  ])('bounds every character despite burst size and arrival cadence: %j', ({ chunks }) => {
    const row = renderHook(({ text }) => useNativeChatPacedText('reply', text, true), {
      wrapper: within(),
      initialProps: { text: '' }
    })
    const arrivals: number[] = []
    const visible: number[] = []
    let text = ''
    let next = 0
    const end = (chunks.at(-1)?.[0] ?? 0) + D
    for (let now = 0; now <= end; now += 1) {
      while (next < chunks.length && chunks[next][0] === now) {
        const count = chunks[next][1]
        // Spaces ensure this exercises incremental words rather than one unbroken token.
        text += 'a '.repeat(Math.ceil(count / 2)).slice(0, count)
        for (let i = 0; i < count; i += 1) {
          arrivals.push(now)
        }
        row.rerender({ text })
        next += 1
      }
      advance(1)
      while (visible.length < row.result.current.text.length) {
        visible.push(now + 1)
      }
    }
    expect(arrivals.length).toBeGreaterThan(0)
    expect(visible).toHaveLength(arrivals.length)
    const maxDelay = visible.reduce((max, time, index) => Math.max(max, time - arrivals[index]), 0)
    expect(maxDelay).toBeLessThanOrEqual(D)
  })

  it('shows an unfinished word at its deadline, including after the reply ends', () => {
    const row = renderHook(
      ({ streaming }) => useNativeChatPacedText('reply', 'hello supercalifragilistic', streaming),
      {
        wrapper: within(),
        initialProps: { streaming: true }
      }
    )
    advance(60)
    expect(row.result.current.text.length).toBeLessThan(25)
    row.rerender({ streaming: false })
    advance(D - 60)
    expect(row.result.current.text).toBe('hello supercalifragilistic')
    expect(row.result.current.revealing).toBe(false)
    advance(300)
    expect(row.result.current.fading).toBe(false)
  })

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

  it('shows an existing reply immediately on opening a different transcript', () => {
    const wrapper = within({ begun: new Set(), drawn: new Map() })
    const row = renderHook(() => useNativeChatPacedText('reply', 'already received', true), {
      wrapper
    })
    expect(row.result.current.text).toBe('already received')
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
