import { describe, expect, it } from 'vitest'
import { zotzMemoryPressure } from './zotz-memory-pressure'

const GB = 1024 ** 3

describe('zotzMemoryPressure', () => {
  it('reads a 16 GB machine that keeps 2.4 GB free', () => {
    const level = (availableGb: number) =>
      zotzMemoryPressure({
        availableBytes: availableGb * GB,
        totalBytes: 16 * GB,
        minFreeBytes: 2.4 * GB
      })
    expect(level(6)).toBe('ok')
    // Below 20 % of RAM (3.2 GB) and within 1 GB of the minimum (3.4 GB).
    expect(level(3.3)).toBe('elevated')
    expect(level(2.3)).toBe('critical')
  })
})
