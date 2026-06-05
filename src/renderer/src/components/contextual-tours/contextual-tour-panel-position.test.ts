import { describe, expect, it } from 'vitest'
import {
  clampContextualTourPanelPosition,
  getContextualTourPanelCssPosition
} from './contextual-tour-panel-position'

describe('contextual tour panel position', () => {
  it('clamps the panel inside narrow viewports', () => {
    const position = clampContextualTourPanelPosition({
      targetRect: {
        left: 20,
        right: 140,
        top: 40,
        bottom: 100,
        width: 120,
        height: 60
      },
      viewport: { width: 320, height: 220 },
      panel: { width: 304, height: 160 }
    })

    expect(position.left).toBeGreaterThanOrEqual(12)
    expect(position.top).toBeGreaterThanOrEqual(12)
    expect(position.left).toBeLessThanOrEqual(12)
    expect(position.top).toBeLessThanOrEqual(48)
  })

  it('places the panel to the right when room allows and aims the arrow at target center', () => {
    const position = clampContextualTourPanelPosition({
      targetRect: { left: 100, right: 200, top: 200, bottom: 240, width: 100, height: 40 },
      viewport: { width: 1024, height: 768 },
      panel: { width: 320, height: 180 }
    })

    expect(position.placement).toBe('right')
    // panel is positioned to the right of the target, vertically centered;
    // arrow should sit near the panel's vertical center pointing at the target's center
    expect(position.left).toBe(212)
    expect(position.arrowOffset).toBeGreaterThan(60)
    expect(position.arrowOffset).toBeLessThan(120)
  })

  it('converts viewport panel coordinates into hosted dialog coordinates', () => {
    const position = {
      left: 838,
      top: 168,
      placement: 'right' as const,
      arrowOffset: 64
    }

    expect(
      getContextualTourPanelCssPosition({
        position,
        panelHostRect: { left: 500, top: 80 }
      })
    ).toEqual({ left: 338, top: 88, arrowOffset: 64 })
    expect(getContextualTourPanelCssPosition({ position })).toEqual({
      left: 838,
      top: 168,
      arrowOffset: 64
    })
  })

  it('flips below the target when neither side has horizontal room', () => {
    const position = clampContextualTourPanelPosition({
      targetRect: { left: 60, right: 260, top: 40, bottom: 80, width: 200, height: 40 },
      viewport: { width: 320, height: 600 },
      panel: { width: 304, height: 160 }
    })

    expect(position.placement).toBe('bottom')
    expect(position.top).toBeGreaterThanOrEqual(80 + 12)
  })

  it('honors a preferred placement for anchored tip-style tours', () => {
    const position = clampContextualTourPanelPosition({
      targetRect: { left: 280, right: 1160, top: 452, bottom: 453, width: 880, height: 1 },
      viewport: { width: 1512, height: 900 },
      panel: { width: 320, height: 140 },
      preferredPlacement: 'bottom'
    })

    expect(position.placement).toBe('bottom')
    expect(position.top).toBe(465)
    expect(position.left).toBe(560)
  })
})
