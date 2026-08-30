import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAgentStatusEpochClock,
  getAgentStatusEpochNow,
  resetAgentStatusEpochClockForTests
} from './agent-status-epoch-clock'

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

describe('getAgentStatusEpochNow', () => {
  afterEach(() => {
    vi.useRealTimers()
    resetAgentStatusEpochClockForTests()
  })

  it('reads the clock at call time so timers faked after creation still apply', () => {
    // The shipped singleton is built at module load, long before any suite
    // installs fake timers — so the default must call through, not capture.
    const clock = createAgentStatusEpochClock()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)

    expect(clock(1)).toBe(1_700_000_000_000)
  })

  it('rewinds with the store so a reset epoch does not reuse the last sample', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)
    resetAgentStatusEpochClockForTests()
    expect(getAgentStatusEpochNow(0)).toBe(5_000)

    // A suite that rewinds the store to epoch 0 must rewind the sample too.
    vi.setSystemTime(9_000)
    expect(getAgentStatusEpochNow(0)).toBe(5_000)
    resetAgentStatusEpochClockForTests()
    expect(getAgentStatusEpochNow(0)).toBe(9_000)
  })
})
