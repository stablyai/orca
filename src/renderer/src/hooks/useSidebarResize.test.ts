import { describe, expect, it } from 'vitest'
import {
  clampSidebarResizeWidth,
  getNextSidebarResizeWidth,
  getRenderedSidebarWidthCssValue,
  getRenderedSidebarWidthPx,
  interpolateSidebarAnimationWidth
} from './useSidebarResize'

describe('useSidebarResize helpers', () => {
  it('clamps sidebar widths to the configured bounds', () => {
    expect(clampSidebarResizeWidth(100, 220, 500)).toBe(220)
    expect(clampSidebarResizeWidth(320, 220, 500)).toBe(320)
    expect(clampSidebarResizeWidth(640, 220, 500)).toBe(500)
  })

  it('grows the left sidebar as the pointer moves right', () => {
    expect(
      getNextSidebarResizeWidth({
        clientX: 460,
        startX: 400,
        startWidth: 280,
        deltaSign: 1,
        minWidth: 220,
        maxWidth: 500
      })
    ).toBe(340)
  })

  it('grows the right sidebar as the pointer moves left', () => {
    expect(
      getNextSidebarResizeWidth({
        clientX: 340,
        startX: 400,
        startWidth: 280,
        deltaSign: -1,
        minWidth: 220,
        maxWidth: 500
      })
    ).toBe(340)
  })

  it('applies clamping after drag math', () => {
    expect(
      getNextSidebarResizeWidth({
        clientX: 1000,
        startX: 400,
        startWidth: 280,
        deltaSign: 1,
        minWidth: 220,
        maxWidth: 500
      })
    ).toBe(500)

    expect(
      getNextSidebarResizeWidth({
        clientX: 1000,
        startX: 400,
        startWidth: 280,
        deltaSign: -1,
        minWidth: 220,
        maxWidth: 500
      })
    ).toBe(220)
  })

  it('renders closed sidebars at zero width and open sidebars with extra width', () => {
    expect(getRenderedSidebarWidthPx(false, 280, 40)).toBe(0)
    expect(getRenderedSidebarWidthPx(true, 280, 0)).toBe(280)
    expect(getRenderedSidebarWidthPx(true, 280, 40)).toBe(320)
    expect(getRenderedSidebarWidthCssValue(false, 280, 40)).toBe('0px')
    expect(getRenderedSidebarWidthCssValue(true, 280, 0)).toBe('280px')
    expect(getRenderedSidebarWidthCssValue(true, 280, 40)).toBe('320px')
  })

  it('interpolates sidebar toggle widths with clamped easing progress', () => {
    expect(interpolateSidebarAnimationWidth(0, 320, -1)).toBe(0)
    expect(interpolateSidebarAnimationWidth(0, 320, 0)).toBe(0)
    expect(interpolateSidebarAnimationWidth(0, 320, 1)).toBe(320)
    expect(interpolateSidebarAnimationWidth(0, 320, 2)).toBe(320)
    expect(interpolateSidebarAnimationWidth(0, 320, 0.5)).toBe(160)
  })
})
