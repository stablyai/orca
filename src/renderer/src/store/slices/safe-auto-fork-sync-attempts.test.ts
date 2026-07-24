import { describe, expect, it, vi } from 'vitest'
import { SafeAutoForkSyncAttempts } from './safe-auto-fork-sync-attempts'

describe('safe auto-fork sync attempts', () => {
  it('starts every distinct attempt through the exact cap', () => {
    const attempts = new SafeAutoForkSyncAttempts(100, 3)
    const start = vi.fn(() => new Promise<void>(() => undefined))

    expect(attempts.run('a', 0, start)).toBe(true)
    expect(attempts.run('b', 0, start)).toBe(true)
    expect(attempts.run('c', 0, start)).toBe(true)

    expect(start).toHaveBeenCalledTimes(3)
    expect(attempts.evidence()).toEqual({ entries: 3, inFlight: 3 })
  })

  it('rejects one over the cap when every retained attempt is in flight', () => {
    const attempts = new SafeAutoForkSyncAttempts(100, 2)
    const start = vi.fn(() => new Promise<void>(() => undefined))
    attempts.run('a', 0, start)
    attempts.run('b', 0, start)

    expect(attempts.run('overflow', 0, start)).toBe(false)
    expect(start).toHaveBeenCalledTimes(2)
    expect(attempts.evidence()).toEqual({ entries: 2, inFlight: 2 })
  })

  it('evicts the oldest completed cooldown entry before admitting a new key', async () => {
    const attempts = new SafeAutoForkSyncAttempts(100, 2)
    attempts.run('oldest', 0, async () => undefined)
    attempts.run('newer', 1, async () => undefined)
    await Promise.resolve()

    expect(attempts.run('replacement', 2, async () => undefined)).toBe(true)
    expect(attempts.evidence().entries).toBe(2)
    expect(attempts.run('oldest', 3, async () => undefined)).toBe(true)
    expect(attempts.run('newer', 3, async () => undefined)).toBe(false)
  })

  it('preserves the cooldown below its boundary and expires it exactly at the boundary', async () => {
    const attempts = new SafeAutoForkSyncAttempts(100, 2)
    const start = vi.fn(async () => undefined)
    attempts.run('repo', 0, start)
    await Promise.resolve()

    expect(attempts.run('repo', 99, start)).toBe(false)
    expect(attempts.run('repo', 100, start)).toBe(true)
    expect(start).toHaveBeenCalledTimes(2)
  })
})
