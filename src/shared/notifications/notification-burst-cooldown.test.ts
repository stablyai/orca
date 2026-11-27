import { describe, expect, it } from 'vitest'
import { reserveNotificationCooldown } from './notification-burst-cooldown'

function reserveAll(stamps: number[]): boolean[] {
  const recent = new Map<string, number>()
  return stamps.map((at) => reserveNotificationCooldown(recent, 'key', at))
}

describe('reserveNotificationCooldown', () => {
  it('collapses alerts within the window on either side of the held stamp', () => {
    const base = 1_700_000_000_000
    expect(reserveAll([base, base, base + 4_999, base + 5_000])).toEqual([true, false, false, true])
    expect(reserveAll([base, base - 1, base - 4_999, base - 5_000])).toEqual([
      true,
      false,
      false,
      true
    ])
  })

  it('keeps the window anchored when an earlier stamp is reserved late', () => {
    const base = 1_700_000_000_000
    expect(reserveAll([base + 200, base, base + 5_100, base + 5_200])).toEqual([
      true,
      false,
      false,
      true
    ])
  })
})
