import { describe, expect, it } from 'vitest'
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../../../../shared/process-table-snapshot-reader'
import { POLL_TIER_INTERVAL_MS } from './agent-completion-poll-cadence'
import { nextCadenceInspectionDelayMs } from './agent-completion-poll-interval'

const IDLE_MS = POLL_TIER_INTERVAL_MS.idle

describe('nextCadenceInspectionDelayMs', () => {
  const alignedDelay = (now: number): number =>
    nextCadenceInspectionDelayMs({
      baseMs: IDLE_MS,
      hasConsecutiveErrors: false,
      alignToSharedGrid: true,
      now
    })

  it('walks panes that scheduled at different moments onto one shared deadline', () => {
    // Why this matters: the inspection queue collapses shared-observation tasks enqueued in the
    // same tick onto one process-table capture, so a shared deadline is one `ps` for all panes.
    const clocks = [0, 137, 999, 1_501].map((offset) => 1_700_000_000_000 + offset)
    // Each pane may only be pulled forward by the snapshot TTL per step, so convergence takes
    // at most IDLE_MS / TTL steps.
    for (let step = 0; step < IDLE_MS / PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS; step += 1) {
      for (let pane = 0; pane < clocks.length; pane += 1) {
        clocks[pane] += alignedDelay(clocks[pane]!)
      }
    }

    expect(new Set(clocks).size).toBe(1)
  })

  it('never waits longer than the tier interval, nor more than the snapshot TTL less', () => {
    for (let offset = 0; offset < IDLE_MS * 3; offset += 1) {
      const delay = alignedDelay(1_700_000_000_000 + offset)
      expect(delay).toBeGreaterThanOrEqual(IDLE_MS - PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS)
      expect(delay).toBeLessThanOrEqual(IDLE_MS)
    }
  })

  it('keeps jitter while backing off, so a failing host is not retried by every pane at once', () => {
    const lowJitter = nextCadenceInspectionDelayMs({
      baseMs: IDLE_MS,
      hasConsecutiveErrors: true,
      alignToSharedGrid: true,
      now: 1_700_000_000_000,
      random: () => 0
    })
    const highJitter = nextCadenceInspectionDelayMs({
      baseMs: IDLE_MS,
      hasConsecutiveErrors: true,
      alignToSharedGrid: true,
      now: 1_700_000_000_000,
      random: () => 1
    })

    expect(lowJitter).toBe(Math.round(IDLE_MS * 0.9))
    expect(highJitter).toBe(Math.round(IDLE_MS * 1.1))
  })

  it('degrades safely on a non-positive interval', () => {
    for (const baseMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        nextCadenceInspectionDelayMs({
          baseMs,
          hasConsecutiveErrors: false,
          alignToSharedGrid: true,
          now: 1_700_000_000_000
        })
      ).toBe(0)
    }
  })
})
