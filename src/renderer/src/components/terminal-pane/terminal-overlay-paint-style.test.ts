import { describe, expect, it } from 'vitest'
import { getTerminalOverlayPaintStyle } from './terminal-overlay-paint-style'

describe('getTerminalOverlayPaintStyle', () => {
  it('keeps a hidden startup terminal measurable without letting it paint', () => {
    expect(getTerminalOverlayPaintStyle(false, true)).toEqual({
      display: 'flex',
      opacity: 0,
      visibility: 'hidden',
      pointerEvents: 'none'
    })
  })

  it('shows only the active terminal overlay', () => {
    expect(getTerminalOverlayPaintStyle(true, false)).toEqual({
      display: 'flex',
      opacity: 1,
      visibility: 'visible',
      pointerEvents: 'auto'
    })
    expect(getTerminalOverlayPaintStyle(false, false)).toEqual({
      display: 'none',
      opacity: 0,
      visibility: 'hidden',
      pointerEvents: 'none'
    })
  })
})
