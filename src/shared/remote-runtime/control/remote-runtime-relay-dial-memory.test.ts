import { afterEach, expect, it, vi } from 'vitest'
import { RelayOuterError } from '../relay/client/relay-e2ee-link'
import { RelayRuntimeDialMemory } from './remote-runtime-relay-dial-memory'

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
