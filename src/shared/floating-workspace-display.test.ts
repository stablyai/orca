import { describe, expect, it } from 'vitest'
import {
  calculateTargetDisplayBounds,
  findNextDisplay,
  type WorkspaceDisplayInfo
} from './floating-workspace-display'

describe('floating-workspace-display helpers', () => {
  const display1: WorkspaceDisplayInfo = {
    id: 1,
    label: 'Primary Display',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    isPrimary: true,
    scaleFactor: 1
  }

  const display2: WorkspaceDisplayInfo = {
    id: 2,
    label: 'Secondary Display',
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 40, width: 2560, height: 1400 },
    isPrimary: false,
    scaleFactor: 1
  }

  describe('calculateTargetDisplayBounds', () => {
    it('centers default bounds inside target display work area', () => {
      const bounds = calculateTargetDisplayBounds(display2, {
        defaultWidth: 1000,
        defaultHeight: 600
      })
      expect(bounds).toEqual({
        width: 1000,
        height: 600,
        x: 1920 + Math.round((2560 - 1000) / 2),
        y: 40 + Math.round((1400 - 600) / 2)
      })
    })

    it('preserves current window size when fitting within display', () => {
      const bounds = calculateTargetDisplayBounds(display2, {
        currentBounds: { width: 800, height: 500 }
      })
      expect(bounds.width).toBe(800)
      expect(bounds.height).toBe(500)
      expect(bounds.x).toBe(1920 + Math.round((2560 - 800) / 2))
      expect(bounds.y).toBe(40 + Math.round((1400 - 500) / 2))
    })

    it('clamps to target display work area if window is larger than target display', () => {
      const smallDisplay: WorkspaceDisplayInfo = {
        id: 3,
        label: 'Small Display',
        bounds: { x: 0, y: 1080, width: 800, height: 600 },
        workArea: { x: 0, y: 1080, width: 800, height: 550 },
        isPrimary: false,
        scaleFactor: 1
      }
      const bounds = calculateTargetDisplayBounds(smallDisplay, {
        currentBounds: { width: 1200, height: 900 }
      })
      expect(bounds.width).toBe(800)
      expect(bounds.height).toBe(550)
      expect(bounds.x).toBe(0)
      expect(bounds.y).toBe(1080)
    })
  })

  describe('findNextDisplay', () => {
    it('returns null if no displays', () => {
      expect(findNextDisplay([])).toBeNull()
    })

    it('returns the same display if only 1 display exists', () => {
      expect(findNextDisplay([display1])).toBe(display1)
    })

    it('cycles from display 1 to display 2', () => {
      expect(findNextDisplay([display1, display2], 1)).toBe(display2)
    })

    it('cycles from display 2 back to display 1', () => {
      expect(findNextDisplay([display1, display2], 2)).toBe(display1)
    })

    it('picks secondary display by default if current display is unknown', () => {
      expect(findNextDisplay([display1, display2])).toBe(display2)
    })
  })
})
