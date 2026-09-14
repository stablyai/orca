import { describe, it, expect } from 'vitest'
import {
  distanceFromBottom,
  isNearBottom,
  shouldLoadEarlier,
  shouldShowJumpToLatest,
  NATIVE_CHAT_BOTTOM_THRESHOLD_PX
} from './native-chat-autoscroll'

const atBottom = { scrollTop: 952, scrollHeight: 1000, clientHeight: 48 }
const scrolledUp = { scrollTop: 0, scrollHeight: 1000, clientHeight: 48 }
const noOverflow = { scrollTop: 0, scrollHeight: 48, clientHeight: 48 }

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
