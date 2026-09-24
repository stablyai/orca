import { describe, it, expect } from 'vitest'
import {
  distanceFromBottom,
  isNearBottom,
  nextFollowingEnd,
  shouldLoadEarlier,
  shouldShowJumpToLatest,
  NATIVE_CHAT_BOTTOM_THRESHOLD_PX,
  NATIVE_CHAT_FOLLOW_REARM_PX
} from './native-chat-autoscroll'

const atBottom = { scrollTop: 952, scrollHeight: 1000, clientHeight: 48 }
const scrolledUp = { scrollTop: 0, scrollHeight: 1000, clientHeight: 48 }
const noOverflow = { scrollTop: 0, scrollHeight: 48, clientHeight: 48 }

/** A view parked exactly `distance` px above the end of the same document. */
function parkedAbove(distance: number): {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
} {
  return { scrollTop: 952 - distance, scrollHeight: 1000, clientHeight: 48 }
}

describe('distanceFromBottom', () => {
  it('is zero at the exact bottom and never negative', () => {
    expect(distanceFromBottom(atBottom)).toBe(0)
    expect(distanceFromBottom({ scrollTop: 5000, scrollHeight: 1000, clientHeight: 48 })).toBe(0)
  })
})

describe('isNearBottom', () => {
  it('sticks within the threshold and detaches beyond it', () => {
    expect(isNearBottom(atBottom)).toBe(true)
    expect(
      isNearBottom({
        scrollTop: 952 - NATIVE_CHAT_BOTTOM_THRESHOLD_PX,
        scrollHeight: 1000,
        clientHeight: 48
      })
    ).toBe(true)
    expect(isNearBottom(scrolledUp)).toBe(false)
  })
})

describe('shouldShowJumpToLatest', () => {
  it('shows only when detached with content below', () => {
    expect(shouldShowJumpToLatest(false, scrolledUp)).toBe(true)
  })
  it('hides while stuck to bottom', () => {
    expect(shouldShowJumpToLatest(true, scrolledUp)).toBe(false)
  })
  it('hides when there is nothing to scroll', () => {
    expect(shouldShowJumpToLatest(false, noOverflow)).toBe(false)
  })
})

// The browser reports application writes as ordinary scroll events. Explicit
// marks distinguish their delayed echoes from reader movement after growth.
describe('nextFollowingEnd', () => {
  const wellAway = parkedAbove(400)
  const following = {
    following: true,
    programmatic: false,
    geometry: parkedAbove(0),
    previousDistanceFromEnd: 400
  }

  it('follows when the reader reaches the end', () => {
    expect(nextFollowingEnd(following)).toBe(true)
  })

  // The resume bug: history pages in and rows settle their measured heights, so
  // the end runs away from an offset the transcript itself pinned. That is not a
  // reader leaving, and treating it as one strands them mid-transcript.
  it('keeps following when a delayed application scroll arrives after growth', () => {
    expect(nextFollowingEnd({ ...following, programmatic: true, geometry: wellAway })).toBe(true)
  })

  it('treats an unmarked offset away from the end as the reader leaving', () => {
    expect(nextFollowingEnd({ ...following, geometry: wellAway })).toBe(false)
  })

  it.each([0, NATIVE_CHAT_FOLLOW_REARM_PX, 400])(
    'does not reattach a detached reader from an application write %i px from the end',
    (distance) => {
      expect(
        nextFollowingEnd({
          following: false,
          programmatic: true,
          geometry: parkedAbove(distance),
          previousDistanceFromEnd: 400
        })
      ).toBe(false)
    }
  )

  // The jump affordance's wider band must not decide whether a reader follows.
  it('lets the reader park just inside the near-bottom band', () => {
    expect(NATIVE_CHAT_FOLLOW_REARM_PX).toBeLessThan(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
    const parked = parkedAbove(NATIVE_CHAT_BOTTOM_THRESHOLD_PX - 1)
    expect(nextFollowingEnd({ ...following, geometry: parked })).toBe(false)
    expect(isNearBottom(parked)).toBe(true)
    expect(shouldShowJumpToLatest(false, parked)).toBe(false)
  })

  it('re-arms at the band and not one pixel past it', () => {
    const detached = {
      following: false,
      programmatic: false,
      previousDistanceFromEnd: 400
    }
    expect(
      nextFollowingEnd({ ...detached, geometry: parkedAbove(NATIVE_CHAT_FOLLOW_REARM_PX) })
    ).toBe(true)
    expect(
      nextFollowingEnd({ ...detached, geometry: parkedAbove(NATIVE_CHAT_FOLLOW_REARM_PX + 1) })
    ).toBe(false)
  })

  // A smooth scroll marks only where it lands. Leaving the end, its first frames
  // move a pixel or two and are unmarked: read as the reader arriving, they
  // re-armed follow and the next frame rebased the view, cancelling the scroll.
  it('does not reattach a detached reader who is moving away from the end', () => {
    const leaving = { following: false, programmatic: false, previousDistanceFromEnd: 0 }
    expect(nextFollowingEnd({ ...leaving, geometry: parkedAbove(0.3) })).toBe(false)
    expect(nextFollowingEnd({ ...leaving, geometry: parkedAbove(2) })).toBe(false)
    // Arriving from above still reattaches, and standing still at the end does too.
    expect(
      nextFollowingEnd({ ...leaving, previousDistanceFromEnd: 52, geometry: parkedAbove(2) })
    ).toBe(true)
    expect(nextFollowingEnd({ ...leaving, geometry: parkedAbove(0) })).toBe(true)
  })

  it('keeps a following reader through a small move up inside the band', () => {
    expect(
      nextFollowingEnd({ ...following, previousDistanceFromEnd: 0, geometry: parkedAbove(2) })
    ).toBe(true)
  })

  // Sub-pixel and zoom rounding put the true end a fraction short of exact.
  it('holds follow through rounding noise at the end', () => {
    expect(nextFollowingEnd({ ...following, geometry: parkedAbove(1.5) })).toBe(true)
  })
})

// Windowing turns measurement into a constant source of movement: every row that
// resolves its real height changes the content and re-fires the observers that
// ask this question. So "near the top" alone can no longer be the answer.
describe('shouldLoadEarlier', () => {
  const nearTop = { scrollTop: 10, scrollHeight: 4000, clientHeight: 600 }
  const base = {
    geometry: nearTop,
    previousScrollTop: 400,
    hasMore: true,
    loadingEarlier: false,
    itemCount: 40,
    requestedAtItemCount: null
  }

  it('pages in older history when the reader scrolls up to the top', () => {
    expect(shouldLoadEarlier(base)).toBe(true)
  })

  it('says nothing to page when there is no more history', () => {
    expect(shouldLoadEarlier({ ...base, hasMore: false })).toBe(false)
  })

  it('waits for the page already in flight', () => {
    expect(shouldLoadEarlier({ ...base, loadingEarlier: true })).toBe(false)
  })

  it('ignores a position that is not near the top', () => {
    expect(shouldLoadEarlier({ ...base, geometry: { ...nearTop, scrollTop: 400 } })).toBe(false)
  })

  // The bottom pin and a settling measurement both move the view DOWN. Only a
  // reader moving up is asking for older history.
  it('ignores movement towards the bottom', () => {
    expect(shouldLoadEarlier({ ...base, previousScrollTop: 0 })).toBe(false)
  })

  it('asks once per page, not once per measurement, while parked at the top', () => {
    const parked = { ...base, previousScrollTop: 10, requestedAtItemCount: 40 }
    expect(shouldLoadEarlier(parked)).toBe(false)
    // New history arrived and the reader is still at the top: asking again is right.
    expect(shouldLoadEarlier({ ...parked, itemCount: 60 })).toBe(true)
  })
})
