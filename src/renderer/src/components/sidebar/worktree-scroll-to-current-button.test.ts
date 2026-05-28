import { describe, expect, it } from 'vitest'
import { getScrollTopToRevealBounds } from './WorktreeList'

describe('getScrollTopToRevealBounds', () => {
  const makeContainer = (scrollTop: number, clientHeight: number) =>
    ({
      scrollTop,
      clientHeight
    }) as HTMLElement

  it('scrolls upward to reveal a mounted current workspace card above the viewport', () => {
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 60, end: 120 })).toBe(60)
  })

  it('scrolls downward to reveal a mounted current workspace card below the viewport', () => {
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 250, end: 340 })).toBe(140)
  })

  it('does not scroll when the current workspace card is already fully visible', () => {
    expect(getScrollTopToRevealBounds(makeContainer(100, 200), { start: 125, end: 260 })).toBeNull()
  })
})
