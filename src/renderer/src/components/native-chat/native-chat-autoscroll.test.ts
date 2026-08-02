import { describe, it, expect } from 'vitest'
import {
  distanceFromBottom,
  isNearBottom,
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
