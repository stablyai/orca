import { describe, expect, it, vi } from 'vitest'
import { createAgentStatusEpochClock } from './agent-status-epoch-clock'

describe('createAgentStatusEpochClock', () => {
  it('samples once per epoch so repeated renders stay deterministic', () => {
    const readNow = vi.fn<() => number>().mockReturnValueOnce(1_000).mockReturnValueOnce(2_000)
    const clock = createAgentStatusEpochClock(readNow)

    expect(clock(7)).toBe(1_000)
    expect(clock(7)).toBe(1_000)
    expect(readNow).toHaveBeenCalledTimes(1)

    expect(clock(8)).toBe(2_000)
    expect(readNow).toHaveBeenCalledTimes(2)
  })

  it('re-samples when the epoch advances again after repeating', () => {
    let now = 0
    const clock = createAgentStatusEpochClock(() => (now += 100))

    expect(clock(1)).toBe(100)
    expect(clock(2)).toBe(200)
    expect(clock(2)).toBe(200)
    expect(clock(3)).toBe(300)
  })
})
