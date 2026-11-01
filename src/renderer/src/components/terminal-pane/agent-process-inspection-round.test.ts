// A shared local capture must consume one admission start for all due panes; unshared remote reads still cost one each.
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
    // Seven unshared starts must remain, proving the shared round consumed exactly one of eight.
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

    // Launch the full shared burst in one tick so it hits one process-table capture.
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

    expect(started.length).toBeGreaterThan(0)
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
