import { describe, expect, it } from 'vitest'
import { introArrowInset, revealScrollDelta } from './intro-arrow-geometry'

// A 280px callout at x=104 with 1px borders under a row of 36px icons (2px gaps) from x=110.
const callout = { left: 104, right: 384 }
const view = { left: 110, right: 360 }
const base = { callout, borderStart: 1, width: 278, view, scale: 1, rtl: false }

describe('introArrowInset', () => {
  it('gives the settled position while the menu is still scaling open', () => {
    // Scaled 0.98 about the callout's left edge: viewport distances shrink, local ones must not.
    const scaled = { left: 104, right: 104 + 280 * 0.98 }
    expect(
      introArrowInset({ ...base, callout: scaled, iconCenter: 104 + 176 * 0.98, scale: 0.98 }).inset
    ).toBeCloseTo(175)
  })

  it('measures from the right edge in right-to-left layouts', () => {
    expect(introArrowInset({ ...base, rtl: true, iconCenter: 360 })).toEqual({
      inset: 23,
      visible: true
    })
  })

  it('hides the arrow once the phone is scrolled out of the row', () => {
    expect(introArrowInset({ ...base, iconCenter: 380 }).visible).toBe(false)
    expect(introArrowInset({ ...base, iconCenter: 100 }).visible).toBe(false)
  })
})

describe('revealScrollDelta', () => {
  const row = { view, margin: 24, scale: 1 }

  it('scrolls an icon under the end fade into view', () => {
    expect(revealScrollDelta({ ...row, item: { left: 350, right: 386 } })).toBe(50)
  })

  it('scrolls an icon under the start fade into view', () => {
    expect(revealScrollDelta({ ...row, item: { left: 90, right: 126 } })).toBe(-44)
  })

  it('leaves a clear icon alone', () => {
    expect(revealScrollDelta({ ...row, item: { left: 200, right: 236 } })).toBe(0)
  })

  it('returns local px while the menu is scaled', () => {
    expect(
      revealScrollDelta({
        item: { left: 190, right: 208 },
        view: { left: 0, right: 200 },
        margin: 24,
        scale: 0.5
      })
    ).toBe(40)
  })
})
