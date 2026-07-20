import { describe, expect, it } from 'vitest'
import {
  IMAGE_VIEWER_PAN_DRAG_THRESHOLD,
  getImageViewerPanScrollPosition,
  getImageViewerPanTrigger,
  hasImageViewerPanCrossedThreshold
} from './image-viewer-pan'

describe('image viewer pan helpers', () => {
  it('recognizes middle-button and Space-left-button gestures', () => {
    expect(getImageViewerPanTrigger(1, false)).toBe('middle')
    expect(getImageViewerPanTrigger(1, true)).toBe('middle')
    expect(getImageViewerPanTrigger(0, true)).toBe('space-left')
    expect(getImageViewerPanTrigger(0, false)).toBeNull()
    expect(getImageViewerPanTrigger(2, true)).toBeNull()
  })

  it('requires the pointer to cross the drag threshold', () => {
    const start = { x: 10, y: 20 }

    expect(hasImageViewerPanCrossedThreshold(start, { x: 12, y: 22 })).toBe(false)
    expect(
      hasImageViewerPanCrossedThreshold(start, {
        x: 10 + IMAGE_VIEWER_PAN_DRAG_THRESHOLD,
        y: 20
      })
    ).toBe(true)
  })

  it('moves the image with the pointer', () => {
    expect(
      getImageViewerPanScrollPosition({
        startScroll: { x: 120, y: 80 },
        startPointer: { x: 50, y: 50 },
        currentPointer: { x: 70, y: 30 }
      })
    ).toEqual({ x: 100, y: 100 })
  })
})
