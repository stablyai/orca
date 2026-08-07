import { describe, expect, it } from 'vitest'
import { withReconnectJitter } from './reconnect-jitter'

describe('withReconnectJitter', () => {
  it('never returns less than the backoff floor', () => {
    expect(withReconnectJitter(500, () => 0)).toBe(500)
  })

  it('spreads a fleet that was dropped by one shared blip', () => {
    const fleet = Array.from({ length: 32 }, (_, index) =>
      withReconnectJitter(500, () => index / 32)
    )
    expect(new Set(fleet).size).toBeGreaterThan(1)
    expect(Math.min(...fleet)).toBeGreaterThanOrEqual(500)
    expect(Math.max(...fleet)).toBeLessThanOrEqual(600)
  })
})
