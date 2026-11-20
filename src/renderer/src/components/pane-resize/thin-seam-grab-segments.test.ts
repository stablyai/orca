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
    expect(getThinSeamGrabSegments(seam, [row(100), row(235.5), row(941.5)])).toEqual([
      { top: 33, height: 101.5 },
      { top: 168.5, height: 672 },
      { top: 874.5, height: 25.5 }
    ])
  })

  it('ignores rows that do not start at the seam', () => {
    expect(getThinSeamGrabSegments(seam, [row(300, 700)])).toEqual([{ top: 0, height: 900 }])
  })
})
