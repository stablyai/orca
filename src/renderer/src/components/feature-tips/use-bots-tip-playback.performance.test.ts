// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/theme/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => false
}))

import { useBotsTipPlayback } from './use-bots-tip-playback'

// Guards PR #45017: the open card rendered at 30 fps for its whole life, and each render's garbage
// grew the renderer's Blink heap by up to ~800 MB before a GC. It now renders only when a cue lands.
describe('feature tip card playback renders', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance']
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders at its cues, not every frame, through a whole page', async () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useBotsTipPlayback(true)
    })
    renders = 0
    // The first page plays 11.7 s and holds 2 s; 14 s carries it onto the second page.
    for (let ms = 0; ms < 14_000; ms += 16) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16)
      })
    }
    expect(result.current.page).toBe(1)
    expect(renders).toBeLessThan(30)
  })
})
