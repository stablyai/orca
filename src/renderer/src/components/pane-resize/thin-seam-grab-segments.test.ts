import { describe, expect, it } from 'vitest'
import { getThinSeamGrabSegments } from './thin-seam-grab-segments'

const seam = { top: 100, bottom: 1000, left: 400, right: 401 }
const row = (
  top: number,
  left = 401
): { top: number; bottom: number; left: number; right: number } => ({
  top,
  bottom: top + 32,
  left,
  right: left + 300
})

describe('getThinSeamGrabSegments', () => {
  it('leaves a gap at every rendered row on the seam, including deep rows whose position no ratio predicts', () => {
    // Six nested 15/85 splits put the last row where each 1px seam in flow has shifted it.
    expect(getThinSeamGrabSegments(seam, [row(100), row(235.5), row(941.5)], 7)).toEqual([
      { top: 33, height: 101.5 },
      { top: 168.5, height: 672 },
      { top: 874.5, height: 25.5 }
    ])
  })

  it('keeps a row beside a narrow nested column, which starts a few px past the seam', () => {
    // A 3px inner column puts the lower strip 4px right of the outer seam, inside its 7px reach.
    expect(getThinSeamGrabSegments(seam, [row(300, 405)], 7)).toEqual([
      { top: 0, height: 199 },
      { top: 233, height: 667 }
    ])
  })

  it('ignores rows beyond the grab reach', () => {
    expect(getThinSeamGrabSegments(seam, [row(300, 408), row(500, 700)], 7)).toEqual([
      { top: 0, height: 900 }
    ])
  })
})
