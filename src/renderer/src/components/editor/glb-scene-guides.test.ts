import { describe, expect, it } from 'vitest'
import { axisSegmentsFor, gridCellSizeFor } from './glb-scene-guides'

describe('axisSegmentsFor', () => {
  it('runs the floor axes edge to edge so they show past a model built around its origin', () => {
    expect(axisSegmentsFor(0, 0, 5)).toEqual([
      { from: [-5, 0, 0], to: [5, 0, 0] },
      { from: [0, 0, 0], to: [0, 10, 0] },
      { from: [0, 0, -5], to: [0, 0, 5] }
    ])
  })

  it('still reaches the origin under an off-origin model', () => {
    const [x, , z] = axisSegmentsFor(100, -40, 5)
    expect(x).toEqual({ from: [0, 0, 0], to: [105, 0, 0] })
    expect(z).toEqual({ from: [0, 0, -45], to: [0, 0, 0] })
  })
})

describe('gridCellSizeFor', () => {
  it('picks a power-of-ten cell so a model spans several cells whatever its unit scale', () => {
    expect(gridCellSizeFor(1)).toBe(0.1)
    expect(gridCellSizeFor(1.8)).toBe(0.1)
    expect(gridCellSizeFor(2.5)).toBe(1)
    expect(gridCellSizeFor(150)).toBe(10)
    expect(gridCellSizeFor(0.03)).toBeCloseTo(0.01)
  })

  it('still yields a positive cell for a degenerate, zero-size model', () => {
    expect(gridCellSizeFor(0)).toBeGreaterThan(0)
  })
})
