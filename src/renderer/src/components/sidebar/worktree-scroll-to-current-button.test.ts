import { describe, expect, it } from 'vitest'
import { getScrollTopToRevealBounds } from './WorktreeList'

describe('getScrollTopToRevealBounds', () => {
  const makeContainer = (scrollTop: number, clientHeight: number) =>
    ({
      scrollTop,
      clientHeight
    }) as HTMLElement

  it('centers a mounted current workspace card that starts above the viewport', () => {
    // Raw result may be negative; revealElementInScrollContainer clamps it to
    // the list edge so boundary reveals never pad the list.
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 60, end: 120 })).toBe(-10)
  })

  it('centers a mounted current workspace card that starts below the viewport', () => {
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 250, end: 340 })).toBe(195)
  })

  it('recenters a card that is already fully visible', () => {
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 125, end: 260 })).toBe(92.5)
  })
})
