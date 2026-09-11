import { describe, expect, it } from 'vitest'
import { nativeChatPinnedRowIndexes, nativeChatTranscriptRange } from './native-chat-pinned-rows'

describe('pinned transcript rows', () => {
  it('pins the live row at the end of the transcript', () => {
    expect([...nativeChatPinnedRowIndexes({ count: 40 })]).toEqual([39])
  })

  it('pins nothing when there is nothing to pin', () => {
    expect(nativeChatPinnedRowIndexes({ count: 0 }).size).toBe(0)
  })

  it('pins a row a reveal is aimed at, wherever it sits', () => {
    expect([...nativeChatPinnedRowIndexes({ count: 40, revealIndex: 3 })].sort((a, b) => a - b)) //
      .toEqual([3, 39])
  })

  it('ignores a reveal target that is no longer in the transcript', () => {
    expect([...nativeChatPinnedRowIndexes({ count: 5, revealIndex: -1 })]).toEqual([4])
    expect([...nativeChatPinnedRowIndexes({ count: 5, revealIndex: 99 })]).toEqual([4])
  })
})

describe('transcript window range', () => {
  const range = { startIndex: 10, endIndex: 12, overscan: 2, count: 100 }

  it('widens the window by overscan on both sides', () => {
    expect(nativeChatTranscriptRange(range, new Set())).toEqual([8, 9, 10, 11, 12, 13, 14])
  })

  it('clamps to the transcript at both ends', () => {
    expect(
      nativeChatTranscriptRange({ startIndex: 0, endIndex: 1, overscan: 3, count: 3 }, new Set())
    ).toEqual([0, 1, 2])
  })

  it('adds pinned rows outside the window, in transcript order and without repeats', () => {
    expect(nativeChatTranscriptRange(range, new Set([99, 11, 0]))).toEqual([
      0, 8, 9, 10, 11, 12, 13, 14, 99
    ])
  })

  it('drops a pinned row that is out of bounds rather than mounting nothing at it', () => {
    expect(nativeChatTranscriptRange(range, new Set([100, -1]))).toEqual([8, 9, 10, 11, 12, 13, 14])
  })
})
