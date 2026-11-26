import { afterEach, expect, it, vi } from 'vitest'
import { RelayOuterError } from '../relay/client/relay-e2ee-link'
import { RelayDirectorHttpError } from '../relay/client/relay-director-resolve'
import { RelayDialAbortedError } from '../relay/client/relay-director-fallback'
import { dialRelayRuntimeLink, RelayRuntimeDialMemory } from './remote-runtime-relay-dial-memory'

const START = 1_000_000
const hostOffline = () => new RelayOuterError(4404)

afterEach(() => vi.useRealTimers())

function heldFor(memory: RelayRuntimeDialMemory): number {
  let dialedAt: number | null = null
  const cancel = memory.afterHold(() => {
    dialedAt = Date.now()
  })
  vi.advanceTimersByTime(60_000)
  cancel()
  return (dialedAt ?? Infinity) - (Date.now() - 60_000)
}

it('holds an offline host 1.5 s, doubling to a jittered 15 s cap', () => {
  vi.useFakeTimers({ now: START })
  const holds = (random: number) => {
    const memory = new RelayRuntimeDialMemory(Date.now, () => random)
    return Array.from({ length: 7 }, () => {
      memory.noteDialFailed(hostOffline())
      return heldFor(memory)
    })
  }
  expect(holds(1)).toEqual([1_500, 3_000, 6_000, 12_000, 15_000, 15_000, 15_000])
  expect(holds(0)).toEqual([1_500, 1_500, 3_000, 6_000, 7_500, 7_500, 7_500])
})

it('waits on one timer that an explicit Connect releases at once', () => {
  vi.useFakeTimers({ now: START })
  const memory = new RelayRuntimeDialMemory(Date.now, () => 1)
  memory.noteDialFailed(hostOffline())
  memory.noteDialFailed(hostOffline())
  const dial = vi.fn()
  memory.afterHold(dial)
  vi.advanceTimersByTime(100)
  expect(dial).not.toHaveBeenCalled()
  memory.clearHold()
  expect(dial).toHaveBeenCalledTimes(1)
  // Lifted: the next dial goes out at once.
  memory.afterHold(dial)
  expect(dial).toHaveBeenCalledTimes(2)
})

it('keeps a director pause, and drops every hold once connected', () => {
  vi.useFakeTimers({ now: START })
  const memory = new RelayRuntimeDialMemory(Date.now, () => 1)
  memory.noteRetryAfter(20_000)
  expect(heldFor(memory)).toBe(20_000)
  memory.noteDialFailed(hostOffline())
  memory.noteConnected()
  expect(heldFor(memory)).toBe(0)
})

/** Dials a link whose every dial answers `answer` (a closed link after `limit`, to stop a loop). */
async function dialWith(memory: RelayRuntimeDialMemory, answer: () => Error, limit = 50) {
  let dials = 0
  await dialRelayRuntimeLink({
    endpoint: 'ws://127.0.0.1:1',
    resumeToken: null,
    memory,
    cell: () => ({ cellUrl: 'https://cell.test', relayHostId: 'H'.repeat(16) }),
    dialOnce: async () => {
      dials += 1
      return { ok: false, error: dials > limit ? new RelayDialAbortedError() : answer() }
    },
    store: { entry: () => undefined, save: () => {} },
    beforeRedial: () => {}
  })
  return dials
}

it('ends an offline episode on a failure no hold paces, instead of redialing at once', async () => {
  vi.useFakeTimers({ now: START })
  const memory = new RelayRuntimeDialMemory(Date.now, () => 1)
  memory.noteDialFailed(hostOffline())
  memory.noteDialFailed(hostOffline())
  vi.advanceTimersByTime(10_000)
  // The network dropped (1006) once the hold had passed: one dial, then the channel ends.
  expect(await dialWith(memory, () => new RelayOuterError(1006))).toBe(1)
})

it("holds a redial within an offline episode for the director's Retry-After", async () => {
  vi.useFakeTimers({ now: START })
  const memory = new RelayRuntimeDialMemory(Date.now, () => 1)
  memory.noteDialFailed(hostOffline())
  memory.noteDialFailed(hostOffline())
  await dialWith(memory, () => new RelayDirectorHttpError(429, 20_000), 1)
  expect(heldFor(memory)).toBe(20_000)
})
