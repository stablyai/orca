import { describe, expect, it } from 'vitest'
import { CLIPBOARD_IMAGE_MAX_PIXELS } from '../../../../shared/clipboard-image'
import { DIAGRAM_PNG_PADDING, diagramPngLayout } from './mermaid-diagram-png'

describe('diagramPngLayout', () => {
  it('renders ordinary diagrams at 2x including padding', () => {
    const layout = diagramPngLayout({ width: 800, height: 400 })
    expect(layout).toEqual({
      width: (800 + DIAGRAM_PNG_PADDING * 2) * 2,
      height: (400 + DIAGRAM_PNG_PADDING * 2) * 2,
      pixelRatio: 2
    })
  })

  it('scales huge diagrams down to the clipboard pixel budget', () => {
    const layout = diagramPngLayout({ width: 8000, height: 6000 })
    expect(layout?.pixelRatio).toBeLessThan(2)
    expect((layout?.width ?? Infinity) * (layout?.height ?? Infinity)).toBeLessThanOrEqual(
      CLIPBOARD_IMAGE_MAX_PIXELS
    )
  })

  it('keeps very wide diagrams within the canvas side limit', () => {
    const layout = diagramPngLayout({ width: 40000, height: 300 })
    expect(layout?.width).toBeLessThanOrEqual(16384)
  })

  it('returns null for an unmeasured diagram', () => {
    expect(diagramPngLayout({ width: 0, height: 100 })).toBeNull()
  })
})
