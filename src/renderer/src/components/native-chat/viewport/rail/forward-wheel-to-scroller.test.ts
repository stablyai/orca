import { describe, expect, it } from 'vitest'
import { forwardWheelToScroller } from './forward-wheel-to-scroller'

const scroller = (scrollTop = 0, clientHeight = 400): HTMLElement =>
  ({ scrollTop, clientHeight }) as HTMLElement

const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) => ({ deltaY, deltaMode, ctrlKey })

describe('forwardWheelToScroller', () => {
  it('moves the scroller by a pixel-mode delta', () => {
    const element = scroller(100)
    expect(forwardWheelToScroller(element, wheel(40))).toBe(40)
    expect(element.scrollTop).toBe(140)
  })

  it('converts a line-mode delta to pixels', () => {
    const element = scroller()
    expect(forwardWheelToScroller(element, wheel(3, 1))).toBe(48)
    expect(element.scrollTop).toBe(48)
  })

  it('converts a page-mode delta to a viewport height', () => {
    const element = scroller(0, 400)
    expect(forwardWheelToScroller(element, wheel(2, 2))).toBe(800)
    expect(element.scrollTop).toBe(800)
  })

  it('leaves a pinch-zoom alone', () => {
    const element = scroller(100)
    expect(forwardWheelToScroller(element, wheel(40, 0, true))).toBeNull()
    expect(element.scrollTop).toBe(100)
  })
})
