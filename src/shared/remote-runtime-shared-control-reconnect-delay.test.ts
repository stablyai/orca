import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleSharedControlReconnect } from './remote-runtime-shared-control-state'

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000] as const

describe('shared-control reconnect delay', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([
    { attempt: 0, random: 0, expected: 250 },
    { attempt: 0, random: 0.999_999, expected: 299 },
    { attempt: 7, random: 0, expected: 24_000 },
    { attempt: 7, random: 0.5, expected: 27_000 },
    { attempt: 7, random: 0.999_999, expected: 29_999 }
  ])(
    'uses cap-contained jitter for attempt $attempt at random=$random',
    ({ attempt, random, expected }) => {
      vi.useFakeTimers()
      vi.spyOn(Math, 'random').mockReturnValue(random)
      const timeout = vi.spyOn(globalThis, 'setTimeout')
      const open = vi.fn()

      const result = scheduleSharedControlReconnect({
        current: null,
        intentionallyClosed: false,
        reconnectAttempt: attempt,
        delaysMs: RECONNECT_DELAYS_MS,
        open
      })

      expect(timeout).toHaveBeenLastCalledWith(open, expected)
      expect(result.reconnectAttempt).toBe(attempt + 1)
    }
  )
})
