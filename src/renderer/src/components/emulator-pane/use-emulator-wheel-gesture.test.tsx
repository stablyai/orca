// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useEmulatorWheelGesture } from './use-emulator-wheel-gesture'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('discards canceled fallback movement and accepts the next wheel gesture', () => {
  vi.useFakeTimers()
  const sendTouch = vi.fn(() => false)
  const onGesture = vi.fn()
  const { result } = renderHook(() => useEmulatorWheelGesture(sendTouch, onGesture))

  act(() => {
    result.current.queue({ start: { x: 0.5, y: 0.5 }, delta: { x: 0, y: -0.06 } })
    vi.advanceTimersByTime(16)
    result.current.cancel()
    vi.advanceTimersByTime(1000)
  })
  expect(onGesture).not.toHaveBeenCalled()

  act(() => {
    result.current.queue({ start: { x: 0.5, y: 0.5 }, delta: { x: 0, y: -0.06 } })
    vi.advanceTimersByTime(1000)
  })
  expect(onGesture).toHaveBeenCalledExactlyOnceWith([
    { type: 'begin', x: 0.5, y: 0.5 },
    { type: 'move', x: 0.5, y: 0.47 },
    { type: 'end', x: 0.5, y: 0.44 }
  ])
})
