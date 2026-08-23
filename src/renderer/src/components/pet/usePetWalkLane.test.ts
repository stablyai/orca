// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePetWalkLane } from './usePetWalkLane'
import { PET_WALK_SPEED_PX_PER_SEC } from './pet-walk-lane'

/** Hands back the queued rAF callbacks so a test can choose the frame gap. */
function captureFrames(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  return frames
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('usePetWalkLane', () => {
  it('clamps a long frame so a backgrounded window does not teleport the pet', () => {
    const frames = captureFrames()
    let x = 100
    const onAdvance = vi.fn((next: number) => {
      x = next
    })

    renderHook(() => usePetWalkLane({ active: true, size: 64, readX: () => x, onAdvance }))

    // The first tick only sets the baseline; the second carries the whole gap.
    act(() => {
      frames[0](0)
    })
    act(() => {
      frames[1](5_000)
    })

    expect(onAdvance).toHaveBeenCalledTimes(1)
    expect(onAdvance).toHaveBeenCalledWith(100 + (PET_WALK_SPEED_PX_PER_SEC * 50) / 1000)
  })

  it('advances a normal frame at full speed', () => {
    const frames = captureFrames()
    let x = 100
    const onAdvance = vi.fn((next: number) => {
      x = next
    })

    renderHook(() => usePetWalkLane({ active: true, size: 64, readX: () => x, onAdvance }))

    act(() => {
      frames[0](0)
    })
    act(() => {
      frames[1](16)
    })

    expect(onAdvance).toHaveBeenCalledWith(100 + (PET_WALK_SPEED_PX_PER_SEC * 16) / 1000)
  })

  // Why these two: `PetOverlay.walk.test.tsx` drives a single 1000ms frame as
  // shorthand for a second of walking, which the clamp no longer honours. These
  // pin the step patterns that replace it.
  it('covers a second of travel in frames the clamp accepts', () => {
    const frames = captureFrames()
    let x = 300
    renderHook(() =>
      usePetWalkLane({
        active: true,
        size: 180,
        readX: () => x,
        onAdvance: (next) => {
          x = next
        }
      })
    )

    act(() => {
      for (let timestamp = 0; timestamp <= 1_000; timestamp += 50) {
        frames.at(-1)?.(timestamp)
      }
    })

    expect(x).toBeCloseTo(300 + PET_WALK_SPEED_PX_PER_SEC, 5)
  })

  it('turns at the right edge after twelve clamped frames', () => {
    const frames = captureFrames()
    // 1200 viewport - 180 pet = 1020, twenty pixels away.
    vi.stubGlobal('innerWidth', 1_200)
    let x = 1_000
    const hook = renderHook(() =>
      usePetWalkLane({
        active: true,
        size: 180,
        readX: () => x,
        onAdvance: (next) => {
          x = next
        }
      })
    )

    act(() => {
      for (let timestamp = 0; timestamp <= 600; timestamp += 50) {
        frames.at(-1)?.(timestamp)
      }
    })

    expect(x).toBe(1_020)
    expect(hook.result.current).toBe('left')
  })
})
