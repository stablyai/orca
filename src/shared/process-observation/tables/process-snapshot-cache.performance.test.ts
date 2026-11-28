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

it('does not join a poll that later reports argv captured before the cleanup boundary', async () => {
  let now = 100
  let reportInputAt: ((atMs: number) => void) | undefined
  const poll = Promise.withResolvers<string>()
  const runPs = vi
    .fn()
    .mockImplementationOnce((_mode, inputAt) => {
      reportInputAt = inputAt
      return poll.promise
    })
    .mockResolvedValueOnce('after-boundary')
  const reader = createProcessTableSnapshotReader<string>({ runPs, now: () => now })

  const display = reader.getSnapshot()
  now += 10
  const cleanup = reader.getSnapshotWithAge(now)
  reportInputAt?.(90)
  poll.resolve('stale-poll')

  await expect(display).resolves.toBe('stale-poll')
  await expect(cleanup).resolves.toMatchObject({ value: 'after-boundary' })
  expect(runPs.mock.calls.map(([mode]) => mode)).toEqual(['poll', 'after-boundary'])
})

it.each([300, 3_000])(
  'shares one elapsed capture across %i checks from one action, then releases it',
  async (count) => {
    vi.useFakeTimers({ now: 100, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      const runPs = vi.fn(async () => {
        vi.advanceTimersByTime(600)
        return { rows: ['shell'] }
      })
      const reader = createProcessTableSnapshotReader({ runPs, now: () => Date.now() })
      const boundary = Date.now()
      for (let index = 0; index < count; index += 4) {
        const observations = await Promise.all(
          Array.from({ length: 4 }, () => reader.getSnapshotWithAge(boundary))
        )
        expect(observations[0]?.value.rows).toEqual(['shell'])
        // Each round is short, but the whole batch runs far past the TTL.
        vi.advanceTimersByTime(50)
      }
      expect(runPs).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(600)
      expect((await reader.getSnapshotWithAge(boundary)).value.rows).toEqual(['shell'])
      expect(runPs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  }
)
