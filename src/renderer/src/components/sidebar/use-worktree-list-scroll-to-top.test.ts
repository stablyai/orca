// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeListScrollToTop } from './use-worktree-list-scroll-to-top'
import { HARD_SCROLL_UP } from './worktree-list-hard-scroll-up'

let clockMs = 0

function advance(ms: number): void {
  clockMs += ms
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function createViewportElement({
  scrollTop = 1200,
  scrollHeight = 5000,
  clientHeight = 1000
}: { scrollTop?: number; scrollHeight?: number; clientHeight?: number } = {}): HTMLElement {
  const element = document.createElement('div')
  // happy-dom reports zero layout; stub the metrics the detector reads.
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true })
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true })
  Object.defineProperty(element, 'scrollTop', {
    value: scrollTop,
    configurable: true,
    writable: true
  })
  element.scrollTo = vi.fn(() => {
    element.scrollTop = 0
  }) as unknown as HTMLElement['scrollTo']
  element.focus = vi.fn()
  document.body.append(element)
  return element
}

/** Enough upward wheel travel to clear `hardTotalDeltaPx` inside the intent window. */
function dispatchHardWheelUp(element: HTMLElement, samples = 4): void {
  for (let i = 0; i < samples; i += 1) {
    clockMs += 16
    act(() => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -240 }))
    })
  }
}

describe('useWorktreeListScrollToTop', () => {
  beforeEach(() => {
    clockMs = 0
    vi.useFakeTimers()
    vi.spyOn(window.performance, 'now').mockImplementation(() => clockMs)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('shows on a hard upward wheel gesture and hides on the idle deadline', () => {
    const element = createViewportElement()
    const { result } = renderHook(() => useWorktreeListScrollToTop({ scrollElement: element }))

    dispatchHardWheelUp(element)
    expect(result.current.showScrollToTop).toBe(true)

    advance(HARD_SCROLL_UP.hideAfterIdleMs)
    expect(result.current.showScrollToTop).toBe(false)
  })

  it('does not extend the idle deadline on non-intent scroll noise', () => {
    const element = createViewportElement()
    const { result } = renderHook(() => useWorktreeListScrollToTop({ scrollElement: element }))

    dispatchHardWheelUp(element)
    const intentAt = clockMs
    // Let the hard samples age out so later ticks are judged on their own.
    advance(HARD_SCROLL_UP.windowMs + 16)

    // Gentle upward ticks keep arriving but never refresh intent.
    for (let i = 0; i < 6; i += 1) {
      advance(200)
      act(() => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -4 }))
      })
    }
    expect(clockMs - intentAt).toBeLessThan(HARD_SCROLL_UP.hideAfterIdleMs)
    expect(result.current.showScrollToTop).toBe(true)

    advance(intentAt + HARD_SCROLL_UP.hideAfterIdleMs - clockMs)
    expect(result.current.showScrollToTop).toBe(false)
  })

  it('re-arms the idle timer when intent is refreshed', () => {
    const element = createViewportElement()
    const { result } = renderHook(() => useWorktreeListScrollToTop({ scrollElement: element }))

    dispatchHardWheelUp(element)
    advance(HARD_SCROLL_UP.hideAfterIdleMs - 200)
    expect(result.current.showScrollToTop).toBe(true)

    dispatchHardWheelUp(element)
    advance(HARD_SCROLL_UP.hideAfterIdleMs - 200)
    expect(result.current.showScrollToTop).toBe(true)

    advance(200)
    expect(result.current.showScrollToTop).toBe(false)
  })

  it('suppresses detection for the post-jump window after scrollToTop', () => {
    const element = createViewportElement()
    const onUserScrollIntent = vi.fn()
    const { result } = renderHook(() =>
      useWorktreeListScrollToTop({ scrollElement: element, onUserScrollIntent })
    )

    dispatchHardWheelUp(element)
    act(() => {
      result.current.scrollToTop()
    })
    const jumpAt = clockMs
    expect(onUserScrollIntent).toHaveBeenCalledTimes(1)
    expect(element.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' })
    expect(result.current.showScrollToTop).toBe(false)

    // Momentum events land back at depth while suppression is active.
    element.scrollTop = 1200
    dispatchHardWheelUp(element)
    expect(clockMs).toBeLessThan(jumpAt + HARD_SCROLL_UP.suppressAfterJumpMs)
    expect(result.current.showScrollToTop).toBe(false)

    advance(HARD_SCROLL_UP.suppressAfterJumpMs)
    dispatchHardWheelUp(element)
    expect(result.current.showScrollToTop).toBe(true)
  })

  it('force-hides when the list stops being scrollable, even mid-gesture', () => {
    const element = createViewportElement()
    const { result } = renderHook(() => useWorktreeListScrollToTop({ scrollElement: element }))

    dispatchHardWheelUp(element)
    expect(result.current.showScrollToTop).toBe(true)

    Object.defineProperty(element, 'scrollHeight', { value: 1100, configurable: true })
    act(() => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -240 }))
    })
    expect(result.current.showScrollToTop).toBe(false)

    // The pending idle timer was cleared, so nothing flips state later.
    advance(HARD_SCROLL_UP.hideAfterIdleMs * 2)
    expect(result.current.showScrollToTop).toBe(false)
  })

  it('clears the timer and detaches listeners when the scroll element goes away', () => {
    const element = createViewportElement()
    const { result, rerender } = renderHook(
      ({ scrollElement }: { scrollElement: HTMLElement | null }) =>
        useWorktreeListScrollToTop({ scrollElement }),
      { initialProps: { scrollElement: element as HTMLElement | null } }
    )

    dispatchHardWheelUp(element)
    expect(result.current.showScrollToTop).toBe(true)

    rerender({ scrollElement: null })
    expect(result.current.showScrollToTop).toBe(false)

    dispatchHardWheelUp(element)
    advance(HARD_SCROLL_UP.hideAfterIdleMs * 2)
    expect(result.current.showScrollToTop).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
