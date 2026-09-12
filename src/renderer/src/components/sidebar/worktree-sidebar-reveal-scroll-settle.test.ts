import { describe, expect, it } from 'vitest'
import {
  createPendingRevealScroll,
  isRevealScrollSettling,
  REVEAL_SCROLL_SETTLE_TIMEOUT_MS
} from './worktree-sidebar-reveal-scroll-settle'

describe('isRevealScrollSettling', () => {
  it('is not settling without a reveal scroll in flight', () => {
    expect(isRevealScrollSettling({ now: 0, pending: null, scrollTop: 120 })).toBe(false)
  })

  it('stays settling while a smooth reveal scroll is still animating', () => {
    // Regression: the anchor restore wrote scrollTop two frames into the animation and
    // cancelled it after a couple of pixels, so revealing took several button clicks.
    const pending = createPendingRevealScroll(387, 0)
    expect(isRevealScrollSettling({ now: 16, pending, scrollTop: 2 })).toBe(true)
    expect(isRevealScrollSettling({ now: 200, pending, scrollTop: 260 })).toBe(true)
  })

  it('stops settling once the scroll reaches its target', () => {
    const pending = createPendingRevealScroll(387, 0)
    expect(isRevealScrollSettling({ now: 300, pending, scrollTop: 387 })).toBe(false)
    // Sub-pixel landings still count as arrived.
    expect(isRevealScrollSettling({ now: 300, pending, scrollTop: 386.5 })).toBe(false)
  })

  it('stops settling after the timeout so an unreachable target cannot pin the guard open', () => {
    const pending = createPendingRevealScroll(387, 0)
    expect(
      isRevealScrollSettling({ now: REVEAL_SCROLL_SETTLE_TIMEOUT_MS, pending, scrollTop: 40 })
    ).toBe(false)
  })
})
