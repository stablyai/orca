import { describe, expect, it, vi } from 'vitest'
import {
  mapWebSessionSnapshotRecoveries,
  WEB_SESSION_SNAPSHOT_RECOVERY_CONCURRENCY
} from './web-session-snapshot-recovery-pool'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return {
    promise: new Promise<void>((nextResolve) => {
      resolve = nextResolve
    }),
    resolve
  }
}

describe('web session snapshot recovery pool', () => {
  it.each([
    ['at the limit', WEB_SESSION_SNAPSHOT_RECOVERY_CONCURRENCY],
    ['above the limit', WEB_SESSION_SNAPSHOT_RECOVERY_CONCURRENCY + 1]
  ])('bounds recovery concurrency %s', async (_label, count) => {
    const releases = Array.from({ length: count }, deferred)
    let active = 0
    let peak = 0
    let started = 0
    const recover = vi.fn(async (value: number) => {
      const release = releases[started]
      started += 1
      active += 1
      peak = Math.max(peak, active)
      await release.promise
      active -= 1
      return value * 2
    })

    const recovery = mapWebSessionSnapshotRecoveries(
      Array.from({ length: count }, (_, index) => index),
      recover
    )
    await vi.waitFor(() =>
      expect(started).toBe(Math.min(count, WEB_SESSION_SNAPSHOT_RECOVERY_CONCURRENCY))
    )
    if (count > WEB_SESSION_SNAPSHOT_RECOVERY_CONCURRENCY) {
      releases[0].resolve()
      await vi.waitFor(() => expect(started).toBe(count))
    }
    releases.forEach(({ resolve }) => resolve())

    await expect(recovery).resolves.toEqual(Array.from({ length: count }, (_, index) => index * 2))
    expect(peak).toBe(Math.min(count, WEB_SESSION_SNAPSHOT_RECOVERY_CONCURRENCY))
  })
})
