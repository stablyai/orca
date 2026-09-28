// Regression guard for the inspection admission budget. The cadence tiers
// (active 750ms / idle 2000 / hidden 3000 / no-evidence 15000) were a per-pane
// promise the queue could not keep: the budget of 8 starts per second was spent
// one pane at a time, so N due panes meant roughly N/8 seconds between
// inspections for each of them and agent-completion latency degraded as the
// user added panes. Local inspections all resolve out of one TTL-and-in-flight-
// deduped process-table capture, so a whole round of them is one host
// observation and rides one start, launched in a single tick. The budget itself
// is unchanged — it just buys the whole round instead of one pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueAgentProcessInspection,
  resetAgentProcessInspectionQueueForTests
} from './agent-process-inspection-queue'

const PANES = 300

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  resetAgentProcessInspectionQueueForTests()
})

describe('agent process inspection rounds', () => {
  it('inspects every pane of a 300-pane round inside the same admission budget', async () => {
    const inspected = new Set<string>()

    for (let index = 0; index < PANES; index += 1) {
      const ptyId = `pty-${index}`
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        sharesHostObservation: true,
        run: async () => {
          await Promise.resolve()
          inspected.add(ptyId)
        }
      })
    }
    // Well inside one 1s rate-limiter window: pre-fix only the 8 starts that window
    // allows are spent, so only 8 of the 300 panes are ever inspected.
    await vi.advanceTimersByTimeAsync(200)

    expect(inspected.size).toBe(PANES)
  })

  it('launches the whole round in one tick on one start', async () => {
    const launchesPerTick = new Map<number, number>()
    let unshared = 0

    for (let index = 0; index < PANES; index += 1) {
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        sharesHostObservation: true,
        run: async () => {
          // Fake timers freeze the clock inside a tick, so a shared timestamp is a shared burst.
          const tick = Date.now()
          launchesPerTick.set(tick, (launchesPerTick.get(tick) ?? 0) + 1)
        }
      })
    }
    // Seven unshared panes still fit, which is what proves the round cost exactly one of
    // the eight starts rather than one per pane until the concurrency slots filled.
    for (let index = 0; index < 7; index += 1) {
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        sharesHostObservation: false,
        run: async () => {
          unshared += 1
        }
      })
    }
    await vi.advanceTimersByTimeAsync(200)

    // One synchronous burst carries every pane, so they hit one process-table capture
    // rather than serializing across the limiter.
    expect([...launchesPerTick.values()]).toEqual([PANES])
    expect(unshared).toBe(7)
  })

  it('keeps a pane whose read is not shared admitted one round trip at a time', async () => {
    const started: string[] = []

    for (let index = 0; index < PANES; index += 1) {
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        // Remote panes: each costs its own execution-host round trip, so no round shares them.
        sharesHostObservation: false,
        run: async () => {
          started.push(`ssh-${index}`)
        }
      })
    }
    await vi.advanceTimersByTimeAsync(200)

    expect(started.length).toBeLessThanOrEqual(8)
  })

  it('still serves a pending-title read ahead of the queued cadence backlog', async () => {
    const order: string[] = []

    for (let index = 0; index < 20; index += 1) {
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => true,
        sharesHostObservation: false,
        run: async () => {
          order.push(`cadence-${index}`)
        }
      })
    }
    enqueueAgentProcessInspection({
      priority: 'pending-title',
      canRun: () => true,
      sharesHostObservation: false,
      run: async () => {
        order.push('pending-title')
      }
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(order.length).toBeLessThanOrEqual(8)
    expect(order).toContain('pending-title')
  })

  it('drops disposed panes out of the round instead of inspecting them', async () => {
    const inspected: number[] = []

    for (let index = 0; index < PANES; index += 1) {
      enqueueAgentProcessInspection({
        priority: 'cadence',
        canRun: () => index % 2 === 0,
        sharesHostObservation: true,
        run: async () => {
          inspected.push(index)
        }
      })
    }
    await vi.advanceTimersByTimeAsync(200)

    expect(inspected).toEqual(Array.from({ length: PANES / 2 }, (_unused, index) => index * 2))
  })
})
