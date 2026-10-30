import { describe, it, expect } from 'vitest'
import {
  isNearBottom,
  nextFollowingEnd,
  shouldShowJumpToLatest,
  NATIVE_CHAT_BOTTOM_THRESHOLD_PX,
  NATIVE_CHAT_FOLLOW_REARM_PX
} from './native-chat-autoscroll'

/** A view parked exactly `distance` px above the end of the same document. */
function parkedAbove(distance: number): {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
} {
  return { scrollTop: 952 - distance, scrollHeight: 1000, clientHeight: 48 }
}

// Application writes emit ordinary browser scroll events; explicit marks distinguish delayed echoes from reader movement.
describe('nextFollowingEnd', () => {
  const wellAway = parkedAbove(400)
  const following = {
    following: true,
    programmatic: false,
    geometry: parkedAbove(0),
    previousDistanceFromEnd: 400,
    settling: false
  }

  // Growth after application pinning is not reader detachment, even if the scroll event arrives late.
  it('keeps following when a delayed application scroll arrives after growth', () => {
    expect(nextFollowingEnd({ ...following, programmatic: true, geometry: wellAway })).toBe(true)
  })

  it.each([0, NATIVE_CHAT_FOLLOW_REARM_PX, 400])(
    'does not reattach a detached reader from an application write %i px from the end',
    (distance) => {
      expect(
        nextFollowingEnd({
          following: false,
          programmatic: true,
          geometry: parkedAbove(distance),
          previousDistanceFromEnd: 400,
          settling: false
        })
      ).toBe(false)
    }
  )

  // The jump affordance's wider band must not decide whether a reader follows.
  it('lets the reader park just inside the near-bottom band', () => {
    expect(NATIVE_CHAT_FOLLOW_REARM_PX).toBeLessThan(NATIVE_CHAT_BOTTOM_THRESHOLD_PX)
    const parked = parkedAbove(NATIVE_CHAT_BOTTOM_THRESHOLD_PX - 1)
    expect(nextFollowingEnd({ ...following, following: false, geometry: parked })).toBe(false)
    expect(isNearBottom(parked)).toBe(true)
    expect(shouldShowJumpToLatest(false, parked)).toBe(false)
  })

  // Early smooth-scroll frames may be unmarked; movement away from the end must not rearm follow.
  it('does not reattach a detached reader who is moving away from the end', () => {
    const leaving = {
      following: false,
      programmatic: false,
      previousDistanceFromEnd: 0,
      settling: false
    }
    expect(nextFollowingEnd({ ...leaving, geometry: parkedAbove(0.3) })).toBe(false)
    expect(nextFollowingEnd({ ...leaving, geometry: parkedAbove(2) })).toBe(false)
    // Arriving from above still reattaches, and standing still at the end does too.
    expect(
      nextFollowingEnd({ ...leaving, previousDistanceFromEnd: 52, geometry: parkedAbove(2) })
    ).toBe(true)
    expect(nextFollowingEnd({ ...leaving, geometry: parkedAbove(0) })).toBe(true)
  })

  it('does not reattach a jump still travelling when shrinking content clamps it onto the end', () => {
    const clamped = {
      following: false,
      programmatic: false,
      previousDistanceFromEnd: 35,
      geometry: parkedAbove(0)
    }
    expect(nextFollowingEnd({ ...clamped, settling: true })).toBe(false)
    expect(nextFollowingEnd({ ...clamped, settling: false })).toBe(true)
  })
})
