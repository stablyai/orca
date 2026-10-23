import { describe, expect, it } from 'vitest'
import {
  formatBrowserPageViewportSize,
  shouldShowBrowserPageViewportSizeFeedback,
  toBrowserPageGuestViewportSize
} from './browser-page-viewport-size'

describe('toBrowserPageGuestViewportSize', () => {
  it('matches the host box at default page zoom', () => {
    expect(toBrowserPageGuestViewportSize({ width: 1024, height: 768 }, 0)).toEqual({
      width: 1024,
      height: 768
    })
  })

  it('divides by the exact page zoom factor, not the rounded percent', () => {
    // Level -1 is 83.33%, so 1000 DIP holds a 1200 CSS px wide page.
    expect(toBrowserPageGuestViewportSize({ width: 1000, height: 500 }, -1)).toEqual({
      width: 1200,
      height: 600
    })
    expect(toBrowserPageGuestViewportSize({ width: 1200, height: 600 }, 1)).toEqual({
      width: 1000,
      height: 500
    })
  })
})

it('matches what the guest reported in the e2e under UI zoom and page zoom-out', () => {
  // 410.83 CSS px at 1.2 UI zoom is 493 DIP; Blink adds 1 before dividing when zoomed in.
  expect(
    toBrowserPageGuestViewportSize({ width: 410.8333 * 1.2, height: 555.677 * 1.2 }, 1)
  ).toEqual({ width: 411, height: 556 })
  // 90% zoom divides without the extra 1.
  expect(
    toBrowserPageGuestViewportSize({ width: 669, height: 689 }, Math.log(0.9) / Math.log(1.2))
  ).toEqual({ width: 743, height: 765 })
})

describe('shouldShowBrowserPageViewportSizeFeedback', () => {
  it('stays hidden for the first measurement', () => {
    expect(shouldShowBrowserPageViewportSizeFeedback(null, { width: 800, height: 600 })).toBe(false)
  })

  it('shows when a visible size changes', () => {
    expect(
      shouldShowBrowserPageViewportSizeFeedback(
        { width: 800, height: 600 },
        { width: 760, height: 600 }
      )
    ).toBe(true)
  })

  it('stays hidden when the rounded size is unchanged', () => {
    expect(
      shouldShowBrowserPageViewportSizeFeedback(
        { width: 800, height: 600 },
        { width: 800, height: 600 }
      )
    ).toBe(false)
  })

  it('stays hidden when the pane is hidden or shown again', () => {
    expect(
      shouldShowBrowserPageViewportSizeFeedback(
        { width: 800, height: 600 },
        { width: 0, height: 0 }
      )
    ).toBe(false)
    expect(
      shouldShowBrowserPageViewportSizeFeedback(
        { width: 0, height: 0 },
        { width: 1000, height: 600 }
      )
    ).toBe(false)
  })
})

it('formats the size like Chrome DevTools', () => {
  expect(formatBrowserPageViewportSize({ width: 1024, height: 768 })).toBe('1024 × 768')
})
