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
  it('keeps both completion and anchor restoration suppressed while native motion continues past the hint', () => {
    const pending = createPendingRevealScroll(20_000, 0)
    expect(isRevealScrollSettling({ now: 900, pending, scrollTop: 10_000 })).toBe(true)
    expect(isRevealScrollSettling({ now: 1_010, pending, scrollTop: 11_000 })).toBe(true)
    expect(isRevealScrollSettling({ now: 1_030, pending, scrollTop: 11_000 })).toBe(true)
    expect(isRevealScrollSettling({ now: 1_050, pending, scrollTop: 11_100 })).toBe(true)
    expect(isRevealScrollSettling({ now: 1_151, pending, scrollTop: 11_100 })).toBe(false)
  })

  it('bounds continuous movement even when the destination is unreachable', () => {
    const pending = createPendingRevealScroll(20_000, 0)
    expect(isRevealScrollSettling({ now: 1_990, pending, scrollTop: 11_100 })).toBe(false)
    expect(isRevealScrollSettling({ now: 1_995, pending, scrollTop: 11_200 })).toBe(true)
    expect(isRevealScrollSettling({ now: 2_000, pending, scrollTop: 11_300 })).toBe(false)
  })
})
