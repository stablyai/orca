import { describe, expect, it } from 'vitest'
import { clampResourceManagerPosition } from './resource-manager-drag-bounds'

const rect = {
  left: 500,
  right: 900,
  top: 200,
  bottom: 600,
  width: 400,
  height: 400
}

describe('clampResourceManagerPosition', () => {
  it('keeps a fitting panel inside the viewport margin', () => {
    expect(
      clampResourceManagerPosition({
        current: { x: 0, y: 0 },
        proposed: { x: 800, y: -500 },
        rect,
        viewportWidth: 1_000,
        viewportHeight: 800,
        margin: 8,
        recoveryHeight: 32
      })
    ).toEqual({ x: 92, y: -192 })
  })

  it('uses the live translated rectangle when clamping a later drag', () => {
    expect(
      clampResourceManagerPosition({
        current: { x: 50, y: -100 },
        proposed: { x: -900, y: 600 },
        rect: { ...rect, left: 550, right: 950, top: 100, bottom: 500 },
        viewportWidth: 1_000,
        viewportHeight: 800,
        margin: 8,
        recoveryHeight: 32
      })
    ).toEqual({ x: -492, y: 192 })
  })

  it('keeps the recovery header visible when the panel is taller than the viewport', () => {
    expect(
      clampResourceManagerPosition({
        current: { x: 0, y: 0 },
        proposed: { x: 0, y: -1_000 },
        rect: { ...rect, top: 40, bottom: 940, height: 900 },
        viewportWidth: 1_000,
        viewportHeight: 700,
        margin: 8,
        recoveryHeight: 32
      })
    ).toEqual({ x: 0, y: -32 })
  })

  it('does not let an oversized panel leave through the bottom or right edge', () => {
    expect(
      clampResourceManagerPosition({
        current: { x: 0, y: 0 },
        proposed: { x: 2_000, y: 2_000 },
        rect: { left: 40, right: 1_140, top: 40, bottom: 940, width: 1_100, height: 900 },
        viewportWidth: 1_000,
        viewportHeight: 700,
        margin: 8,
        recoveryHeight: 32
      })
    ).toEqual({ x: 952, y: 620 })
  })

  // Why: a saved offset from a larger display must not strand the panel
  // off-screen once the viewport shrinks (window resize, monitor change).
  it('pulls a panel parked off a shrunken viewport back into view', () => {
    const recovered = clampResourceManagerPosition({
      current: { x: 1_200, y: 700 },
      proposed: { x: 1_200, y: 700 },
      rect: { left: 1_500, right: 1_900, top: 900, bottom: 1_300, width: 400, height: 400 },
      viewportWidth: 800,
      viewportHeight: 600,
      margin: 8,
      recoveryHeight: 32
    })
    expect(recovered).toEqual({ x: 92, y: -8 })
    // Applying the recovered offset lands the panel fully back inside the
    // shrunken viewport, flush against the trailing margins.
    expect(1_500 + (recovered.x - 1_200)).toBe(392)
    expect(1_900 + (recovered.x - 1_200)).toBe(800 - 8)
    expect(900 + (recovered.y - 700)).toBe(192)
    expect(1_300 + (recovered.y - 700)).toBe(600 - 8)
  })

  it('is idempotent for a position already inside the viewport', () => {
    const settled = { x: 40, y: -20 }
    expect(
      clampResourceManagerPosition({
        current: settled,
        proposed: settled,
        rect,
        viewportWidth: 1_000,
        viewportHeight: 800,
        margin: 8,
        recoveryHeight: 32
      })
    ).toEqual(settled)
  })

  // Why: clamp() applies the lower bound last, so a panel wider than the
  // viewport must still resolve to a left-edge-visible offset, never NaN.
  it('prefers the leading edge when the panel cannot fit either axis', () => {
    expect(
      clampResourceManagerPosition({
        current: { x: 0, y: 0 },
        proposed: { x: -5_000, y: -5_000 },
        rect: { left: 0, right: 1_600, top: 0, bottom: 1_200, width: 1_600, height: 1_200 },
        viewportWidth: 900,
        viewportHeight: 600,
        margin: 8,
        recoveryHeight: 32
      })
    ).toEqual({ x: 8, y: 8 })
  })
})
