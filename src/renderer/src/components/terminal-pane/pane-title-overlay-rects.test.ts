import { describe, expect, it } from 'vitest'
import {
  arePaneTitleOverlayRectsEqual,
  clearPaneTitleOverlayRects
} from './pane-title-overlay-rects'

describe('clearPaneTitleOverlayRects', () => {
  // Why: this identity contract IS the React #185 guard — a fresh {} literal is
  // never state-equal, so returning one here commits a render every pass.
  it('returns the same reference when already empty', () => {
    const prev = {}
    expect(clearPaneTitleOverlayRects(prev)).toBe(prev)
  })

  it('clears a populated map to a new empty object', () => {
    const prev = { 1: { left: 10, top: 20, width: 30 } }
    const next = clearPaneTitleOverlayRects(prev)

    expect(next).not.toBe(prev)
    expect(next).toEqual({})
  })

  it('is stable across repeated calls once empty', () => {
    const first = clearPaneTitleOverlayRects({ 1: { left: 1, top: 2, width: 3 } })
    expect(clearPaneTitleOverlayRects(first)).toBe(first)
  })
})

describe('arePaneTitleOverlayRectsEqual', () => {
  it('treats sub-pixel drift as equal', () => {
    expect(
      arePaneTitleOverlayRectsEqual(
        { 1: { left: 10, top: 20, width: 30 } },
        { 1: { left: 10.4, top: 20.4, width: 30.4 } }
      )
    ).toBe(true)
  })

  it('treats a half-pixel-or-greater move as different', () => {
    expect(
      arePaneTitleOverlayRectsEqual(
        { 1: { left: 10, top: 20, width: 30 } },
        { 1: { left: 10.5, top: 20, width: 30 } }
      )
    ).toBe(false)
  })

  it('treats differing pane counts as different', () => {
    expect(
      arePaneTitleOverlayRectsEqual(
        { 1: { left: 0, top: 0, width: 10 } },
        { 1: { left: 0, top: 0, width: 10 }, 2: { left: 0, top: 0, width: 10 } }
      )
    ).toBe(false)
  })

  it('reports two empty maps as equal', () => {
    expect(arePaneTitleOverlayRectsEqual({}, {})).toBe(true)
  })
})
