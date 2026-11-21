import { expect, it, vi } from 'vitest'
import { createProcessTableSnapshotReader } from './process-snapshot-cache'

it.each([300, 3_000])(
  'shares one elapsed capture across %i checks from one action',
  async (count) => {
    let now = 100
    const runPs = vi.fn(async () => {
      now += 600
      return { rows: ['shell'] }
    })
    const reader = createProcessTableSnapshotReader({ runPs, now: () => now })
    const boundary = now
    for (let index = 0; index < count; index += 4) {
      const observations = await Promise.all(
        Array.from({ length: 4 }, () => reader.getSnapshotWithAge(boundary))
      )
      expect(observations[0]?.value.rows).toEqual(['shell'])
      now += 50
    }
    expect(runPs).toHaveBeenCalledTimes(1)
    expect((await reader.getSnapshotWithAge(now)).value.rows).toEqual(['shell'])
    expect(runPs).toHaveBeenCalledTimes(2)
  }
)
