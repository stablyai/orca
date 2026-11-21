// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('@/hooks/theme/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => motion.reduced
}))

import { useBotsTipPlayback } from './use-bots-tip-playback'

/** Plays in frame-sized steps, so each page change renders before the clock runs on. */
async function play(seconds: number): Promise<void> {
  for (let left = Math.round(seconds * 1000); left > 0; left -= 50) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(50, left))
    })
  }
}

describe('the announcement pages', () => {
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
    vi.useRealTimers()
  })

  it('moves on 2 s after each page ends and loops from the last page to the first', async () => {
    const { result } = renderHook(() => useBotsTipPlayback(true))
    // Page ends: 11.7 s, 16.2 s, 13 s; each holds 2 s.
    await play(13.5)
    expect(result.current.page).toBe(0)
    await play(0.4)
    expect(result.current.page).toBe(1)
    await play(18.2)
    expect(result.current.page).toBe(2)
    await play(15.1)
    expect(result.current.page).toBe(0)
    expect(result.current.t).toBeLessThan(1)
  })

  it('starts a chosen page from its beginning and keeps cycling from there', async () => {
    const { result } = renderHook(() => useBotsTipPlayback(true))
    await play(5)
    act(() => result.current.goTo(2))
    expect(result.current.page).toBe(2)
    expect(result.current.t).toBe(0)
    await play(14.9)
    expect(result.current.page).toBe(2)
    await play(0.2)
    expect(result.current.page).toBe(0)
  })

  it('shows each page finished and stays put under reduced motion', async () => {
    motion.reduced = true
    const { result } = renderHook(() => useBotsTipPlayback(true))
    expect(result.current.pageTimes).toEqual([11.7, 16.2, 13])
    await play(60)
    expect(result.current.page).toBe(0)
    act(() => result.current.goTo(1))
    expect(result.current.page).toBe(1)
    expect(result.current.t).toBe(16.2)
  })
})
