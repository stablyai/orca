// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeListScrollToTop } from './use-scroll-to-top'

function createScroller(): HTMLElement {
  const element = document.createElement('div')
  element.tabIndex = 0
  document.body.append(element)
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 5000 },
    clientHeight: { configurable: true, value: 500 },
    // 16px narrower than offsetWidth so the scrollbar hit-test has a realistic gutter.
    clientWidth: { configurable: true, value: 284 },
    offsetWidth: { configurable: true, value: 300 }
  })
  element.getBoundingClientRect = () => ({
    bottom: 500,
    height: 500,
    left: 0,
    right: 300,
    top: 0,
    width: 300,
    x: 0,
    y: 0,
    toJSON: () => ({})
  })
  return element
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('useWorktreeListScrollToTop', () => {
  it('ignores fast programmatic scrolling', () => {
    const element = createScroller()
    let now = 0
    vi.spyOn(window.performance, 'now').mockImplementation(() => now)
    const view = renderHook(() => useWorktreeListScrollToTop({ scrollElement: element }))

    for (const sample of [
      { t: 0, scrollTop: 2200 },
      { t: 80, scrollTop: 2000 },
      { t: 170, scrollTop: 1700 }
    ]) {
      now = sample.t
      element.scrollTop = sample.scrollTop
      act(() => element.dispatchEvent(new Event('scroll')))
    }

    expect(view.result.current.showScrollToTop).toBe(false)
  })

  it('detects velocity while the scrollbar is actively dragged', () => {
    const element = createScroller()
    let now = 0
    vi.spyOn(window.performance, 'now').mockImplementation(() => now)
    const view = renderHook(() => useWorktreeListScrollToTop({ scrollElement: element }))

    act(() =>
      element.dispatchEvent(new PointerEvent('pointerdown', { clientX: 295, pointerType: 'mouse' }))
    )
    for (const sample of [
      { t: 0, scrollTop: 2200 },
      { t: 80, scrollTop: 2000 },
      { t: 170, scrollTop: 1700 }
    ]) {
      now = sample.t
      element.scrollTop = sample.scrollTop
      act(() => element.dispatchEvent(new Event('scroll')))
    }

    expect(view.result.current.showScrollToTop).toBe(true)
  })

  it('returns focus to the list after jumping to the top', () => {
    const element = createScroller()
    element.scrollTop = 1200
    element.scrollTo = vi.fn(({ top }) => {
      element.scrollTop = Number(top)
    })
    const view = renderHook(() => useWorktreeListScrollToTop({ scrollElement: element }))

    act(() => {
      for (let index = 0; index < 4; index += 1) {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }))
      }
    })
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()

    act(() => view.result.current.scrollToTop())

    expect(element.scrollTop).toBe(0)
    expect(document.activeElement).toBe(element)
  })
})
