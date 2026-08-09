import { describe, expect, it } from 'vitest'
import {
  isNativeChatNearBottom,
  nativeChatDistanceFromBottom,
  NATIVE_CHAT_BOTTOM_THRESHOLD_PX,
  shouldShowNativeChatJumpToLatest
} from './native-chat-scroll-geometry'

describe('nativeChatDistanceFromBottom', () => {
  it('is zero at the exact bottom and never negative', () => {
    expect(nativeChatDistanceFromBottom(952, 1000, 48)).toBe(0)
    expect(nativeChatDistanceFromBottom(5000, 1000, 48)).toBe(0)
  })
})

describe('isNativeChatNearBottom', () => {
  it('sticks within the threshold and detaches beyond it', () => {
    expect(isNativeChatNearBottom(952, 1000, 48)).toBe(true)
    expect(isNativeChatNearBottom(952 - NATIVE_CHAT_BOTTOM_THRESHOLD_PX, 1000, 48)).toBe(true)
    expect(isNativeChatNearBottom(0, 1000, 48)).toBe(false)
  })
})

describe('shouldShowNativeChatJumpToLatest', () => {
  it('shows only when detached with content below', () => {
    expect(shouldShowNativeChatJumpToLatest(false, 0, 1000, 48)).toBe(true)
  })

  it('hides while stuck to bottom', () => {
    expect(shouldShowNativeChatJumpToLatest(true, 0, 1000, 48)).toBe(false)
  })

  it('hides when there is nothing to scroll', () => {
    expect(shouldShowNativeChatJumpToLatest(false, 0, 48, 48)).toBe(false)
  })
})
