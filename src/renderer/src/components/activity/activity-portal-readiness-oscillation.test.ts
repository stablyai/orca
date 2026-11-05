import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS,
  ACTIVITY_PORTAL_READINESS_MAX_FLIPS,
  createActivityPortalReadinessLatch
} from './activity-portal-readiness-oscillation'

describe('createActivityPortalReadinessLatch', () => {
  it('latches to unavailable once loading<->unavailable keeps flipping', () => {
    const latch = createActivityPortalReadinessLatch()
    const seen: string[] = []
    for (let i = 0; i < 40; i += 1) {
      seen.push(latch.next(i % 2 === 0 ? 'loading' : 'unavailable'))
    }
    // Settle well before React's 50 nested sync updates throw #185.
    expect(seen.slice(-10).every((status) => status === 'unavailable')).toBe(true)
    expect(seen.indexOf('unavailable')).toBeLessThan(ACTIVITY_PORTAL_READINESS_MAX_FLIPS + 2)
  })

  it('passes through a normal loading -> ready startup', () => {
    const latch = createActivityPortalReadinessLatch()
    expect(latch.next('loading')).toBe('loading')
    expect(latch.next('ready')).toBe('ready')
    expect(latch.next('ready')).toBe('ready')
  })

  it('does not latch when ready keeps refunding the budget', () => {
    const latch = createActivityPortalReadinessLatch()
    for (let i = 0; i < 30; i += 1) {
      expect(latch.next('loading')).toBe('loading')
      expect(latch.next('ready')).toBe('ready')
    }
  })

  it('tolerates a few legitimate flips while xterm attaches', () => {
    const latch = createActivityPortalReadinessLatch()
    expect(latch.next('loading')).toBe('loading')
    expect(latch.next('unavailable')).toBe('unavailable')
    expect(latch.next('loading')).toBe('loading')
    expect(latch.next('ready')).toBe('ready')
  })

  it('releases once the terminal genuinely comes up after a churny attach', () => {
    // A slow SSH host may burn the flip budget before attaching successfully.
    const latch = createActivityPortalReadinessLatch()
    for (let i = 0; i < ACTIVITY_PORTAL_READINESS_MAX_FLIPS + 4; i += 1) {
      latch.next(i % 2 === 0 ? 'loading' : 'unavailable')
    }
    expect(latch.next('unavailable')).toBe('unavailable')
    expect(latch.next('ready')).toBe('ready')
    expect(latch.next('loading')).toBe('loading')
    expect(latch.next('ready')).toBe('ready')
  })

  it('holds the latch for as long as the DOM keeps flipping', () => {
    // The field loop ran 239 renders in 847ms, so the window never empties while it spins.
    const clock = { ms: 0 }
    const latch = createActivityPortalReadinessLatch(() => clock.ms)
    const seen: string[] = []
    for (let i = 0; i < 240; i += 1) {
      clock.ms += 4
      seen.push(latch.next(i % 2 === 0 ? 'loading' : 'unavailable'))
    }
    expect(
      seen.slice(ACTIVITY_PORTAL_READINESS_MAX_FLIPS + 2).every((s) => s === 'unavailable')
    ).toBe(true)
  })

  it('releases a latched pane once the churn stops, so a slow attach still reports loading', () => {
    // A latched pane must not answer for the next pane the Activity slot shows (SSH panes take seconds).
    const clock = { ms: 0 }
    const latch = createActivityPortalReadinessLatch(() => clock.ms)
    for (let i = 0; i < ACTIVITY_PORTAL_READINESS_MAX_FLIPS * 2; i += 1) {
      clock.ms += 5
      latch.next(i % 2 === 0 ? 'loading' : 'unavailable')
    }
    expect(latch.next('loading')).toBe('unavailable')
    clock.ms += ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS
    expect(latch.next('loading')).toBe('loading')
  })

  it('ignores flips paced by a human clicking between threads', () => {
    // The latch outlives the subscription, so thread-hopping must never spend the burst budget.
    const clock = { ms: 0 }
    const latch = createActivityPortalReadinessLatch(() => clock.ms)
    for (let i = 0; i < ACTIVITY_PORTAL_READINESS_MAX_FLIPS * 4; i += 1) {
      clock.ms += 500
      expect(latch.next(i % 2 === 0 ? 'loading' : 'unavailable')).toBe(
        i % 2 === 0 ? 'loading' : 'unavailable'
      )
    }
  })
})
