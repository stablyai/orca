import { describe, expect, it } from 'vitest'
import { stepUIZoomLevel, UI_ZOOM_MAX, UI_ZOOM_MIN, UI_ZOOM_STEP } from './ui-zoom-level'

describe('stepUIZoomLevel', () => {
  it('steps by one increment in each direction', () => {
    expect(stepUIZoomLevel(0, 'in')).toBe(UI_ZOOM_STEP)
    expect(stepUIZoomLevel(0, 'out')).toBe(-UI_ZOOM_STEP)
  })

  it('clamps to the supported range', () => {
    expect(stepUIZoomLevel(UI_ZOOM_MAX, 'in')).toBe(UI_ZOOM_MAX)
    expect(stepUIZoomLevel(UI_ZOOM_MIN, 'out')).toBe(UI_ZOOM_MIN)
  })

  it('reset returns the 100% level regardless of current', () => {
    expect(stepUIZoomLevel(3, 'reset')).toBe(0)
    expect(stepUIZoomLevel(-2, 'reset')).toBe(0)
  })
})
