import { describe, expect, it } from 'vitest'
import { HostReadGate, type HostReadGateClock } from './host-change-read-gate'

const FLOOR = 3_000

/** A gate on a fake clock; `reads` lists when each read started, and each settles `readMs` later unless held. */
function gateOnClock(options: { watching?: boolean; connected?: boolean; readMs?: number } = {}) {
  let now = 10_000
  let timers: { at: number; run: () => void }[] = []
  const clock: HostReadGateClock = {
    now: () => now,
    after: (ms, run) => {
      const timer = { at: now + ms, run }
      timers.push(timer)
      return () => {
        timers = timers.filter((other) => other !== timer)
      }
    }
  }
  const state = { watching: options.watching ?? true, connected: options.connected ?? true }
  const reads: number[] = []
  const settles: number[] = []
  let stale = 0
  const gate: HostReadGate = new HostReadGate({
    floorMs: FLOOR,
    clock,
    read: () => {
      reads.push(now)
      if (options.readMs !== undefined) {
        settles.push(now + options.readMs)
      }
    },
    watching: () => state.watching,
    connected: () => state.connected,
    onStale: () => {
      stale += 1
    }
  })
  const advanceTo = (until: number): void => {
    for (;;) {
      const next = Math.min(
        ...timers.map((timer) => timer.at),
        ...settles.filter((at) => at <= until)
      )
      if (!Number.isFinite(next) || next > until) {
        break
      }
      now = next
      const settleIndex = settles.indexOf(next)
      if (settleIndex !== -1) {
        settles.splice(settleIndex, 1)
        gate.readSettled()
        continue
      }
      const due = timers.filter((timer) => timer.at === next)
      timers = timers.filter((timer) => timer.at !== next)
      due.forEach((timer) => timer.run())
    }
    now = until
  }
  return {
    gate,
    state,
    reads,
    staleMarks: () => stale,
    at: (time: number, run: () => void) => {
      advanceTo(time)
      run()
    },
    advanceTo
  }
}

describe('HostReadGate', () => {
  it.each([
    {
      name: 'a burst of events within the floor of the last read costs one read, at the floor',
      script: (g: ReturnType<typeof gateOnClock>) => {
        g.at(10_000, () => g.gate.changed())
        for (let at = 10_200; at < 12_000; at += 100) {
          g.at(at, () => g.gate.changed())
        }
      },
      reads: [10_000, 13_100]
    },
    {
      name: 'a failed read still holds the next one a floor away',
      // The read settles (fails) at once; the change right after waits out the floor.
      script: (g: ReturnType<typeof gateOnClock>) => {
        g.at(10_000, () => g.gate.changed())
        g.at(10_100, () => g.gate.changed())
      },
      readMs: 0,
      reads: [10_000, 13_000]
    },
    {
      name: 'events during a read cost exactly one more read, once it settles and the floor passes',
      script: (g: ReturnType<typeof gateOnClock>) => {
        g.at(10_000, () => g.gate.changed())
        g.at(10_500, () => g.gate.changed())
        g.at(11_000, () => g.gate.changed())
      },
      readMs: 2_000,
      reads: [10_000, 15_000]
    },
    {
      name: 'reads the caller reports (polls, mounts) count toward the floor',
      script: (g: ReturnType<typeof gateOnClock>) => {
        g.at(10_000, () => g.gate.readStarted())
        g.at(10_100, () => g.gate.readSettled())
        g.at(11_000, () => g.gate.changed())
      },
      reads: [13_100]
    },
    {
      name: 'a requested read skips the floor but still waits for the read in flight',
      script: (g: ReturnType<typeof gateOnClock>) => {
        g.at(10_000, () => g.gate.changed())
        g.at(10_050, () => g.gate.request())
      },
      readMs: 100,
      reads: [10_000, 10_100]
    }
  ])('$name', ({ script, readMs, reads }) => {
    const g = gateOnClock({ readMs: readMs ?? 100 })
    script(g)
    g.advanceTo(60_000)
    expect(g.reads).toEqual(reads)
  })

  it('reads nothing while nobody watches, then once when someone does', () => {
    const g = gateOnClock({ watching: false, readMs: 100 })
    for (let at = 10_000; at < 20_000; at += 1_000) {
      g.at(at, () => g.gate.changed())
    }
    expect(g.reads).toEqual([])
    expect(g.staleMarks()).toBe(10)

    g.state.watching = true
    g.at(20_000, () => g.gate.watched())
    g.at(20_500, () => g.gate.watched())
    g.advanceTo(60_000)
    expect(g.reads).toEqual([20_000])
  })

  it('reads for a reader who polls even with nobody watching, still a floor apart', () => {
    const g = gateOnClock({ watching: false, readMs: 100 })
    g.at(10_000, () => g.gate.polled())
    g.at(11_000, () => g.gate.polled())
    g.at(11_500, () => g.gate.changed())
    g.advanceTo(60_000)
    expect(g.reads).toEqual([10_000, 13_100])
  })

  it('waits out a contact gap, then catches up on what was read before the stream went live again', () => {
    const g = gateOnClock({ readMs: 100 })
    g.at(10_000, () => g.gate.changed())
    g.state.connected = false
    g.at(20_000, () => g.gate.changed())
    g.advanceTo(30_000)
    expect(g.reads).toEqual([10_000])

    g.state.connected = true
    g.at(30_000, () => g.gate.live())
    g.advanceTo(60_000)
    expect(g.reads).toEqual([10_000, 30_000])
  })

  it('treats a read started after the live moment as caught up, and one in flight from before it as not', () => {
    const g = gateOnClock({ readMs: 1_000 })
    g.at(10_000, () => g.gate.changed())
    g.at(10_500, () => g.gate.live(9_500))
    g.advanceTo(20_000)
    expect(g.reads).toEqual([10_000])

    g.at(20_000, () => g.gate.changed())
    g.at(20_500, () => g.gate.live(20_200))
    g.advanceTo(60_000)
    expect(g.reads).toEqual([10_000, 20_000, 24_000])
  })

  it('marks the held answer stale again when a read that predates a change lands', () => {
    const g = gateOnClock({ watching: false })
    g.at(10_000, () => g.gate.readStarted())
    g.at(10_500, () => g.gate.changed())
    g.at(11_000, () => g.gate.readSettled())
    expect(g.staleMarks()).toBe(2)
  })
})
