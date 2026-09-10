import { describe, expect, it } from 'vitest'
import { maestroWorkspacePreviewMode } from './maestro-workspace-visibility'

const canvas = { width: 1200, height: 800 }
const bounds = { x: -380, y: -265, width: 760, height: 530 }

describe('maestroWorkspacePreviewMode', () => {
  it('uses a truthful identity shell when content is unreadably small', () => {
    expect(
      maestroWorkspacePreviewMode({
        bounds,
        canvas,
        viewport: { center: { x: 0, y: 0 }, zoom: 0.1 }
      })
    ).toBe('identity')
  })

  it('keeps a full preview selected at deep zoom', () => {
    expect(
      maestroWorkspacePreviewMode({
        bounds,
        canvas,
        viewport: { center: { x: 0, y: 0 }, zoom: 0.1 },
        selected: true
      })
    ).toBe('full')
  })

  it('suspends a heavy preview outside the overscanned viewport', () => {
    expect(
      maestroWorkspacePreviewMode({
        bounds: { ...bounds, x: 5_000 },
        canvas,
        viewport: { center: { x: 0, y: 0 }, zoom: 1 }
      })
    ).toBe('suspended')
  })

  it('uses separate enter and exit thresholds to avoid zoom flapping', () => {
    const viewport = { center: { x: 0, y: 0 }, zoom: 0.32 }
    expect(maestroWorkspacePreviewMode({ bounds, canvas, viewport, previous: 'full' })).toBe('full')
    expect(maestroWorkspacePreviewMode({ bounds, canvas, viewport, previous: 'identity' })).toBe(
      'identity'
    )
  })
})
