import { describe, expect, it } from 'vitest'
import { shouldForwardRemotePassiveGeometryWhileHeld } from './fit-hold-passive-geometry'

describe('shouldForwardRemotePassiveGeometryWhileHeld', () => {
  it('allows measurement-only forward under mobile-fit', () => {
    expect(shouldForwardRemotePassiveGeometryWhileHeld('mobile-fit')).toBe(true)
  })

  it('blocks passive forward under remote-desktop-fit (would claim ownership)', () => {
    expect(shouldForwardRemotePassiveGeometryWhileHeld('remote-desktop-fit')).toBe(false)
  })

  it('blocks when no hold is active (caller uses reassert path instead)', () => {
    expect(shouldForwardRemotePassiveGeometryWhileHeld(null)).toBe(false)
    expect(shouldForwardRemotePassiveGeometryWhileHeld(undefined)).toBe(false)
  })
})
