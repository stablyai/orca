import { describe, expect, it } from 'vitest'
import {
  clampContextualTourPanelPosition,
  getContextualTourTargetRectInHost
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

  it('translates a viewport target rect into hosted dialog coordinates', () => {
    expect(
      getContextualTourTargetRectInHost(
        { left: 555, right: 1018, top: 240, bottom: 315, width: 463, height: 75 },
        { left: 500, top: 80 }
      )
    ).toEqual({ left: 55, right: 518, top: 160, bottom: 235, width: 463, height: 75 })
  })

  it('keeps a hosted panel inside a dialog whose field spans nearly its full width', () => {
    // Regression: the workspace-creation tour panel was clamped against the
    // viewport, so it sat to the right of the Project field — outside the
    // dialog content that clips overflow — and only a sliver was visible.
    const hostRect = { left: 55, top: 42 }
    const position = clampContextualTourPanelPosition({
      targetRect: getContextualTourTargetRectInHost(
        { left: 110, right: 1018, top: 240, bottom: 315, width: 908, height: 75 },
        hostRect
      ),
      viewport: { width: 1020, height: 910 },
      panel: { width: 320, height: 180 }
    })

    expect(position.placement).toBe('bottom')
    expect(position.left).toBeGreaterThanOrEqual(12)
    expect(position.left + 320).toBeLessThanOrEqual(1020 - 12)
    expect(position.top + 180).toBeLessThanOrEqual(910 - 12)
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
