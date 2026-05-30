import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampFloatingMassCodeBounds,
  getDefaultFloatingMassCodeBounds,
  getMaximizedFloatingMassCodeBounds
} from './floating-masscode-panel-bounds'

function setViewport(width: number, height: number): void {
  vi.stubGlobal('window', { innerWidth: width, innerHeight: height })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('floating massCode panel bounds', () => {
  it('keeps the default panel inside narrow viewports', () => {
    setViewport(360, 520)

    const bounds = getDefaultFloatingMassCodeBounds()

    expect(bounds.left).toBeGreaterThanOrEqual(16)
    expect(bounds.width).toBeLessThanOrEqual(328)
    expect(bounds.top).toBeGreaterThanOrEqual(36)
    expect(bounds.height).toBeLessThanOrEqual(448)
  })

  it('clamps dragged panels back to visible edges', () => {
    setViewport(800, 600)

    const bounds = clampFloatingMassCodeBounds({
      left: 2_000,
      top: -200,
      width: 500,
      height: 300
    })

    expect(bounds.left).toBe(720)
    expect(bounds.top).toBe(36)
  })

  it('maximizes without forcing desktop width on small viewports', () => {
    setViewport(390, 600)

    const bounds = getMaximizedFloatingMassCodeBounds()

    expect(bounds.left).toBe(12)
    expect(bounds.width).toBe(366)
    expect(bounds.height).toBe(528)
  })
})
