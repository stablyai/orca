// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStagedMountPerFrame } from './use-staged-mount-per-frame'

describe('useStagedMountPerFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('admits one card per frame instead of all at once', async () => {
    const { result } = renderHook(() => useStagedMountPerFrame(['a', 'b', 'c']))
    expect(result.current.size).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16)
    })
    expect([...result.current]).toEqual(['a'])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(32)
    })
    expect([...result.current]).toEqual(['a', 'b', 'c'])
  })

  it('drops a card the moment it leaves the range, and never admits one that left mid-stage', async () => {
    const { result, rerender } = renderHook(({ keys }) => useStagedMountPerFrame(keys), {
      initialProps: { keys: ['a', 'b', 'c'] }
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16)
    })
    expect([...result.current]).toEqual(['a'])

    // b and c scroll out before their frame comes up; a stays.
    rerender({ keys: ['a', 'd'] })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(48)
    })
    expect([...result.current].sort()).toEqual(['a', 'd'])
  })

  it('empties the set while disabled and stages again once enabled', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useStagedMountPerFrame(['a', 'b'], enabled),
      { initialProps: { enabled: true } }
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(32)
    })
    expect([...result.current]).toEqual(['a', 'b'])

    rerender({ enabled: false })
    expect(result.current.size).toBe(0)

    rerender({ enabled: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16)
    })
    expect([...result.current]).toEqual(['a'])
  })
})
