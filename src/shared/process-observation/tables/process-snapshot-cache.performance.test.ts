import { expect, it, vi } from 'vitest'
import { createProcessTableSnapshotReader } from './process-snapshot-cache'

it('waits for fresh evidence only while the newer check is active', async () => {
  let now = 100
  const oldCapture = Promise.withResolvers<string>()
  const runPs = vi.fn().mockReturnValueOnce(oldCapture.promise).mockResolvedValue('recent')
  const reader = createProcessTableSnapshotReader<string>({ runPs, now: () => now })
  const first = reader.getSnapshotWithAge(now)
  now += 10
  const cancellation = new AbortController()
  const cancelled = reader.getSnapshotWithAge(now, cancellation.signal)
  cancellation.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  const successor = reader.getSnapshotWithAge(now)
  expect(runPs).toHaveBeenCalledTimes(1)
  oldCapture.resolve('initial')
  await expect(first).resolves.toMatchObject({ value: 'initial' })
  await expect(successor).resolves.toMatchObject({ value: 'recent' })
  expect(runPs).toHaveBeenCalledTimes(2)
})

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
