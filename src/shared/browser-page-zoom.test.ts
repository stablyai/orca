import { describe, expect, it } from 'vitest'
import {
  browserPageZoomLevelToPercent,
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel
} from './browser-page-zoom'

const percentsFrom = (level: number, direction: 'in' | 'out', steps: number): number[] => {
  const percents: number[] = []
  for (let step = 0; step < steps; step++) {
    level = nextBrowserPageZoomLevel(level, direction)
    percents.push(browserPageZoomLevelToPercent(level))
  }
  return percents
}

describe('browser page zoom presets', () => {
  it("steps through Chrome's presets and stops at 25% and 500%", () => {
    expect(percentsFrom(0, 'in', 10)).toEqual([110, 125, 150, 175, 200, 250, 300, 400, 500, 500])
    expect(percentsFrom(0, 'out', 8)).toEqual([90, 80, 75, 67, 50, 33, 25, 25])
  })

  it('snaps levels saved before the presets to the nearest one', () => {
    // 0.5-level steps used to give 110%, 131%, 144% and 173%.
    expect(
      [0.5, 1.5, 2, 3].map(normalizeBrowserPageZoomLevel).map(browserPageZoomLevelToPercent)
    ).toEqual([110, 125, 150, 175])
    expect(normalizeBrowserPageZoomLevel(Number.NaN)).toBe(0)
  })

  it('resets to the level it is given', () => {
    expect(nextBrowserPageZoomLevel(3, 'reset', normalizeBrowserPageZoomLevel(1.5))).toBe(
      normalizeBrowserPageZoomLevel(1.5)
    )
  })
})
