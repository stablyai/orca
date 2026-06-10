import { describe, expect, it } from 'vitest'
import { getContextualTourOverlayPanelPosition } from './contextual-tour-overlay-position'

function rect(
  partial: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>
): DOMRect {
  return partial as DOMRect
}

function elementWithRect(
  bounds: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>
): HTMLElement {
  return {
    getBoundingClientRect: () => rect(bounds)
  } as HTMLElement
}

describe('contextual tour overlay position', () => {
  it('returns viewport coordinates for floating panels', () => {
    const position = getContextualTourOverlayPanelPosition({
      targetRect: rect({ left: 100, right: 200, top: 200, bottom: 240, width: 100, height: 40 }),
      panelElement: elementWithRect({
        left: 0,
        right: 320,
        top: 0,
        bottom: 180,
        width: 320,
        height: 180
      }),
      panelHost: null,
      viewport: { width: 1024, height: 768 }
    })

    expect(position.panelPlacement).toBe('right')
    expect(position.panelPosition.left).toBe(212)
    expect(position.panelPosition.top).toBe(130)
    expect(position.panelPosition['--contextual-tour-arrow-offset']).toBe('90px')
  })

  it('returns host-local coordinates for panels portaled into clipped dialog content', () => {
    const position = getContextualTourOverlayPanelPosition({
      targetRect: rect({ left: 110, right: 1018, top: 240, bottom: 315, width: 908, height: 75 }),
      panelElement: elementWithRect({
        left: 0,
        right: 320,
        top: 0,
        bottom: 180,
        width: 320,
        height: 180
      }),
      panelHost: elementWithRect({
        left: 55,
        right: 1075,
        top: 42,
        bottom: 952,
        width: 1020,
        height: 910
      }),
      viewport: { width: 1512, height: 982 }
    })

    expect(position.panelPlacement).toBe('bottom')
    expect(position.panelPosition.left).toBe(349)
    expect(position.panelPosition.top).toBe(285)
    expect(position.panelPosition.left).toBeGreaterThanOrEqual(12)
    expect(Number(position.panelPosition.left) + 320).toBeLessThanOrEqual(1020 - 12)
    expect(position.panelPosition['--contextual-tour-arrow-offset']).toBe('160px')
  })
})
