// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCloudSetupAutoStart } from './use-cloud-setup-auto-start'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function setup(initial: { done: boolean; visible: boolean }) {
  return renderHook((props) => useCloudSetupAutoStart({ ...props, settleMs: 1_500 }), {
    initialProps: initial
  })
}

describe('setup page auto-start (RR-b)', () => {
  it('visible page: "All set" holds about 1.5 s, then the workspace starts', () => {
    const { result, rerender } = setup({ done: false, visible: true })
    rerender({ done: true, visible: true })
    act(() => vi.advanceTimersByTime(1_400))
    expect(result.current.starting).toBe(false)
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.starting).toBe(true)
  })

  it('hidden page never starts on its own, even after it shows again; Start starts it', () => {
    const { result, rerender } = setup({ done: false, visible: false })
    rerender({ done: true, visible: false })
    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current.starting).toBe(false)
    expect(result.current.heldForStart).toBe(true)
    rerender({ done: true, visible: true })
    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current.starting).toBe(false)
    act(() => result.current.start())
    expect(result.current.starting).toBe(true)
    expect(result.current.heldForStart).toBe(false)
  })

  it('done flickering back before the hold elapses does not start', () => {
    const { result, rerender } = setup({ done: false, visible: true })
    rerender({ done: true, visible: true })
    act(() => vi.advanceTimersByTime(1_000))
    rerender({ done: false, visible: true })
    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current.starting).toBe(false)
  })

  it('leaving the page mid-wait (Escape, ×, Back) unmounts it: nothing starts', () => {
    const { result, rerender, unmount } = setup({ done: false, visible: true })
    rerender({ done: true, visible: true })
    const before = result.current.starting
    unmount()
    act(() => vi.advanceTimersByTime(5_000))
    expect(before).toBe(false)
  })
})
