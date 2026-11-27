import { describe, expect, it } from 'vitest'
import { sideWithRoom } from './link-peek-side'

const at = (left: number, right: number) => ({
  getBoundingClientRect: () => ({ left, right })
})

// A card asked for beside a link must never open past the window's edge, where its Retry is unreachable.
describe('sideWithRoom', () => {
  it('keeps top and bottom as asked', () => {
    expect(sideWithRoom('bottom', at(0, 100), 300)).toBe('bottom')
    expect(sideWithRoom('top', at(0, 100), 300)).toBe('top')
  })

  it('opens left when the card fits there, else right', () => {
    expect(sideWithRoom('left', at(800, 1100), 1200)).toBe('left')
    expect(sideWithRoom('left', at(372, 692), 1200)).toBe('right')
  })

  it('opens below the link when neither side has room', () => {
    expect(sideWithRoom('left', at(0, 310), 310)).toBe('bottom')
  })
})
