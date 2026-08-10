import { describe, expect, it } from 'vitest'
import { NATIVE_CHAT_BOTTOM_THRESHOLD_PX } from './native-chat-autoscroll'
import {
  distanceFromLatest,
  isAtOldestEdge,
  isPinnedToLatest,
  latestScrollTop,
  nativeChatListOrientation,
  orientNativeChatMessages,
  shouldShowJumpAffordance,
  tracksPrependAnchor
} from './native-chat-list-orientation'

// A 500px-tall transcript in a 100px viewport: scrollTop 0 = top, 400 = bottom.
const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 500, clientHeight: 100 })
const shorterThanViewport = { scrollTop: 0, scrollHeight: 80, clientHeight: 100 }

describe('nativeChatListOrientation', () => {
  it('maps the composer-on-top setting onto the newest end', () => {
    expect(nativeChatListOrientation(true)).toBe('newest-first')
    expect(nativeChatListOrientation(false)).toBe('newest-last')
  })
})

describe('distanceFromLatest', () => {
  it('measures from the bottom when the newest turn is last', () => {
    expect(distanceFromLatest('newest-last', at(400))).toBe(0)
    expect(distanceFromLatest('newest-last', at(0))).toBe(400)
  })

  it('measures from the top when the newest turn is first', () => {
    expect(distanceFromLatest('newest-first', at(0))).toBe(0)
    expect(distanceFromLatest('newest-first', at(400))).toBe(400)
  })

  it('treats an unscrollable transcript as pinned in both orientations', () => {
    expect(distanceFromLatest('newest-first', shorterThanViewport)).toBe(0)
    expect(distanceFromLatest('newest-last', shorterThanViewport)).toBe(0)
  })
})

describe('isPinnedToLatest', () => {
  it('stays pinned within the slack that absorbs streaming jitter', () => {
    expect(isPinnedToLatest('newest-first', at(NATIVE_CHAT_BOTTOM_THRESHOLD_PX))).toBe(true)
    expect(isPinnedToLatest('newest-first', at(NATIVE_CHAT_BOTTOM_THRESHOLD_PX + 1))).toBe(false)
    expect(isPinnedToLatest('newest-last', at(400 - NATIVE_CHAT_BOTTOM_THRESHOLD_PX))).toBe(true)
    expect(isPinnedToLatest('newest-last', at(400 - NATIVE_CHAT_BOTTOM_THRESHOLD_PX - 1))).toBe(
      false
    )
  })
})

describe('shouldShowJumpAffordance', () => {
  it('stays hidden while pinned', () => {
    expect(shouldShowJumpAffordance('newest-first', true, at(400))).toBe(false)
    expect(shouldShowJumpAffordance('newest-last', true, at(0))).toBe(false)
  })

  it('shows once the newest turn is off-screen', () => {
    expect(shouldShowJumpAffordance('newest-first', false, at(400))).toBe(true)
    expect(shouldShowJumpAffordance('newest-last', false, at(0))).toBe(true)
  })

  it('never shows when there is nothing to scroll', () => {
    expect(shouldShowJumpAffordance('newest-first', false, shorterThanViewport)).toBe(false)
    expect(shouldShowJumpAffordance('newest-last', false, shorterThanViewport)).toBe(false)
  })
})

describe('latestScrollTop', () => {
  it('pins to the top for newest-first and the bottom for newest-last', () => {
    expect(latestScrollTop('newest-first', at(400))).toBe(0)
    expect(latestScrollTop('newest-last', at(0))).toBe(500)
  })
})

describe('isAtOldestEdge', () => {
  it('pages from the top when the oldest turn is first', () => {
    expect(isAtOldestEdge('newest-last', at(10))).toBe(true)
    expect(isAtOldestEdge('newest-last', at(200))).toBe(false)
  })

  it('pages from the bottom when the oldest turn is last', () => {
    expect(isAtOldestEdge('newest-first', at(390))).toBe(true)
    expect(isAtOldestEdge('newest-first', at(200))).toBe(false)
  })
})

describe('tracksPrependAnchor', () => {
  it('anchors only where older turns land above the viewport', () => {
    expect(tracksPrependAnchor('newest-last')).toBe(true)
    expect(tracksPrependAnchor('newest-first')).toBe(false)
  })
})

describe('orientNativeChatMessages', () => {
  it('reverses without mutating the memoized source array', () => {
    const messages = ['first', 'second', 'third']
    expect(orientNativeChatMessages('newest-first', messages)).toEqual(['third', 'second', 'first'])
    expect(messages).toEqual(['first', 'second', 'third'])
  })

  it('returns the same array reference when the order is unchanged', () => {
    const messages = ['first', 'second']
    expect(orientNativeChatMessages('newest-last', messages)).toBe(messages)
  })
})
