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
