import { describe, expect, it } from 'vitest'
import { advancePetFall, PET_FALL } from './pet-fall-physics'

const opts = { ...PET_FALL, laneY: 500, minX: 0, maxX: 1000 }

describe('advancePetFall', () => {
  it('accelerates downward under gravity', () => {
    const next = advancePetFall({ x: 100, y: 0, vx: 0, vy: 0 }, { ...opts, deltaMs: 100 })
    expect(next.vy).toBeCloseTo(PET_FALL.gravityPxPerSec2 * 0.1, 5)
    expect(next.y).toBeCloseTo(next.vy * 0.1, 5)
    expect(next.landed).toBe(false)
  })

  it('caps at terminal velocity instead of accelerating forever', () => {
    let state = { x: 100, y: 0, vx: 0, vy: 0 }
    for (let i = 0; i < 200; i++) {
      state = advancePetFall(state, { ...opts, deltaMs: 16, laneY: 1e9 })
    }
    expect(state.vy).toBeLessThanOrEqual(PET_FALL.terminalVyPxPerSec)
    expect(state.vy).toBeCloseTo(PET_FALL.terminalVyPxPerSec, 0)
  })

  it('lands exactly on the lane without overshooting', () => {
    const next = advancePetFall({ x: 100, y: 490, vx: 0, vy: 900 }, { ...opts, deltaMs: 100 })
    expect(next.y).toBe(500)
    expect(next.vy).toBe(0)
    expect(next.landed).toBe(true)
  })

  it('carries throw momentum sideways and bleeds it off', () => {
    const first = advancePetFall({ x: 100, y: 0, vx: 600, vy: 0 }, { ...opts, deltaMs: 100 })
    expect(first.x).toBeGreaterThan(100)
    expect(first.vx).toBeLessThan(600)
    expect(first.vx).toBeGreaterThan(0)
  })

  it('stops dead at the wall instead of sliding out of reach', () => {
    const next = advancePetFall({ x: 990, y: 0, vx: 900, vy: 0 }, { ...opts, deltaMs: 100 })
    expect(next.x).toBe(1000)
    expect(next.vx).toBe(0)
  })

  it('lands with the lane clamp winning over a wall hit in the same frame', () => {
    const next = advancePetFall({ x: 990, y: 495, vx: 900, vy: 900 }, { ...opts, deltaMs: 100 })
    expect(next).toMatchObject({ x: 1000, y: 500, vx: 0, vy: 0, landed: true })
  })

  it('stops at the ceiling instead of launching the pet off the top', () => {
    // A hard upward flick peaks ~1200px above the release point, which puts the
    // pet off-screen and ungrabbable for the whole ~2s round trip.
    const next = advancePetFall({ x: 100, y: 20, vx: 0, vy: -2500 }, { ...opts, deltaMs: 100 })

    expect(next.y).toBe(0)
    expect(next.vy).toBe(0)
    expect(next.landed).toBe(false)
  })

  it('falls away from the ceiling on the next frame rather than sticking', () => {
    let state = advancePetFall({ x: 100, y: 20, vx: 0, vy: -2500 }, { ...opts, deltaMs: 100 })
    state = advancePetFall(state, { ...opts, deltaMs: 100 })

    expect(state.vy).toBeGreaterThan(0)
    expect(state.y).toBeGreaterThan(0)
  })
})
