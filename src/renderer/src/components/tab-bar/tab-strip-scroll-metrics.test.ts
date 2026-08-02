import { describe, expect, it } from 'vitest'
import {
  computeTabStripScrollMetrics,
  computeTabStripThumbLayout,
  getTabStripScrollMaskClassName
} from './tab-strip-scroll-metrics'

describe('computeTabStripScrollMetrics', () => {
  it('reports no overflow when all tabs fit', () => {
    expect(
      computeTabStripScrollMetrics({
        scrollWidth: 400,
        clientWidth: 400,
        scrollLeft: 0
      })
    ).toEqual({
      hasOverflow: false,
      canScrollStart: false,
      canScrollEnd: false,
      thumbSizeFraction: 1,
      thumbOffsetFraction: 0
    })
  })

  it('tracks thumb size and offset while scrolled', () => {
    expect(
      computeTabStripScrollMetrics({
        scrollWidth: 800,
        clientWidth: 400,
        scrollLeft: 200
      })
    ).toEqual({
      hasOverflow: true,
      canScrollStart: true,
      canScrollEnd: true,
      thumbSizeFraction: 0.5,
      thumbOffsetFraction: 0.5
    })
  })

  it('marks the start and end scroll edges', () => {
    expect(
      computeTabStripScrollMetrics({
        scrollWidth: 800,
        clientWidth: 400,
        scrollLeft: 0
      }).canScrollStart
    ).toBe(false)
    expect(
      computeTabStripScrollMetrics({
        scrollWidth: 800,
        clientWidth: 400,
        scrollLeft: 0
      }).canScrollEnd
    ).toBe(true)

    expect(
      computeTabStripScrollMetrics({
        scrollWidth: 800,
        clientWidth: 400,
        scrollLeft: 400
      }).canScrollStart
    ).toBe(true)
    expect(
      computeTabStripScrollMetrics({
        scrollWidth: 800,
        clientWidth: 400,
        scrollLeft: 400
      }).canScrollEnd
    ).toBe(false)
  })
})

describe('computeTabStripThumbLayout', () => {
  it('clamps thumb width and keeps the thumb inside the track', () => {
    expect(
      computeTabStripThumbLayout(200, {
        thumbSizeFraction: 0.04,
        thumbOffsetFraction: 1
      })
    ).toEqual({
      widthPx: 18,
      leftPx: 182
    })
  })

  it('uses the raw width when it is already above the minimum', () => {
    expect(
      computeTabStripThumbLayout(400, {
        thumbSizeFraction: 0.5,
        thumbOffsetFraction: 0.25
      })
    ).toEqual({
      widthPx: 200,
      leftPx: 50
    })
  })
})

describe('getTabStripScrollMaskClassName', () => {
  it('returns no classes when the strip does not overflow', () => {
    expect(
      getTabStripScrollMaskClassName({
        hasOverflow: false,
        canScrollStart: false,
        canScrollEnd: false
      })
    ).toBe('')
  })

  it('returns both fade classes when more tabs exist on both sides', () => {
    expect(
      getTabStripScrollMaskClassName({
        hasOverflow: true,
        canScrollStart: true,
        canScrollEnd: true
      })
    ).toBe('terminal-tab-strip--fade-start terminal-tab-strip--fade-end')
  })
})
