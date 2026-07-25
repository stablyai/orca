import { describe, expect, it } from 'vitest'
import { edgeAt } from './use-pet-presence'

describe('edgeAt', () => {
  it('reports no edge for a pet strolling mid-window', () => {
    expect(edgeAt({ x: 0.5, y: 0.5 })).toBeNull()
    expect(edgeAt({ x: 0.2, y: 0.9 })).toBeNull()
  })

  it('detects each edge', () => {
    expect(edgeAt({ x: 0, y: 0.5 })).toBe('left')
    expect(edgeAt({ x: 1, y: 0.5 })).toBe('right')
    expect(edgeAt({ x: 0.5, y: 0 })).toBe('top')
    expect(edgeAt({ x: 0.5, y: 1 })).toBe('bottom')
  })

  it('prefers the horizontal edge in a corner', () => {
    // Why: a corner touches two edges at once, and handing off sideways reads
    // as walking out of a window; upward reads as falling out of the screen.
    expect(edgeAt({ x: 0, y: 0 })).toBe('left')
    expect(edgeAt({ x: 1, y: 1 })).toBe('right')
  })

  it('tolerates positions slightly outside the surface', () => {
    expect(edgeAt({ x: -0.3, y: 0.5 })).toBe('left')
    expect(edgeAt({ x: 1.4, y: 0.5 })).toBe('right')
  })
})
