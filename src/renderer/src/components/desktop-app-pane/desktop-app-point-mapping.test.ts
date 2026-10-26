import { describe, expect, it } from 'vitest'
import { mapElementPointToWindowPoint } from './desktop-app-point-mapping'

describe('desktop app point mapping', () => {
  // A 1280x1016-point window captured at 2x, shown in a 800x800 pane.
  const box = { width: 800, height: 800 }
  const media = { width: 2560, height: 2032 }
  const windowSize = { width: 1280, height: 1016 }

  it('maps pane points to window points', () => {
    const point = mapElementPointToWindowPoint({ x: 400, y: 400 }, box, media, windowSize)
    expect(point).toEqual({ x: 640, y: 508 })
  })

  it('ignores clicks in the letterbox bars', () => {
    expect(mapElementPointToWindowPoint({ x: 400, y: 20 }, box, media, windowSize)).toBeNull()
  })

  it('returns null before the video has a size', () => {
    expect(
      mapElementPointToWindowPoint({ x: 1, y: 1 }, box, { width: 0, height: 0 }, windowSize)
    ).toBeNull()
  })
})
