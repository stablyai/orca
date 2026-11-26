import { describe, expect, it } from 'vitest'
import {
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  percentTextToZoomLevel,
  stepUIZoomLevel,
  zoomLevelToPercent
} from './ui-zoom-level'

function percentsFrom(start: number, direction: 'in' | 'out', count: number): number[] {
  const percents: number[] = []
  let level = start
  for (let step = 0; step < count; step++) {
    level = stepUIZoomLevel(level, direction)
    percents.push(zoomLevelToPercent(level))
  }
  return percents
}

describe('stepUIZoomLevel', () => {
  it('steps out from 100% through round presets to the range end', () => {
    expect(percentsFrom(0, 'out', 6)).toEqual([90, 80, 75, 67, 58, 58])
  })

  it('steps in from 100% through round presets to the range end', () => {
    expect(percentsFrom(0, 'in', 7)).toEqual([110, 125, 150, 175, 200, 249, 249])
  })

  it('moves a level between two stops to the next stop in that direction', () => {
    // 91%, the old half-level step below 100%.
    expect(zoomLevelToPercent(stepUIZoomLevel(-0.5, 'out'))).toBe(90)
    expect(zoomLevelToPercent(stepUIZoomLevel(-0.5, 'in'))).toBe(100)
    // 98%, a typed size.
    const typed = Math.log(0.98) / Math.log(1.2)
    expect(zoomLevelToPercent(stepUIZoomLevel(typed, 'out'))).toBe(90)
    expect(stepUIZoomLevel(typed, 'in')).toBe(0)
  })

  it('treats a level within float noise of a stop as that stop', () => {
    expect(zoomLevelToPercent(stepUIZoomLevel(1e-9, 'in'))).toBe(110)
    expect(zoomLevelToPercent(stepUIZoomLevel(-1e-9, 'out'))).toBe(90)
  })
})

describe('percentTextToZoomLevel', () => {
  it('turns a typed percentage into the level that shows it', () => {
    expect(zoomLevelToPercent(percentTextToZoomLevel('98') ?? Number.NaN)).toBe(98)
    expect(percentTextToZoomLevel(' 100 ')).toBe(0)
  })

  it('clamps to the UI range', () => {
    expect(percentTextToZoomLevel('10')).toBe(UI_ZOOM_MIN)
    expect(percentTextToZoomLevel('500')).toBe(UI_ZOOM_MAX)
  })

  it('rejects text that is not a positive number', () => {
    for (const text of ['', '  ', 'abc', '0', '-50', 'Infinity']) {
      expect(percentTextToZoomLevel(text)).toBeNull()
    }
  })
})
