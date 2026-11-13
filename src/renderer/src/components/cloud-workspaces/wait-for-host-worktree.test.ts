// PICKER-OPEN-INTERMITTENT: the workspace's row lands a moment after the reads that follow pairing;
// opening waits for it (bounded) instead of leaving the person where they were.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    listeners,
    emit: (): void => {
      for (const listener of Array.from(listeners)) {
        listener()
      }
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: (listener: () => void) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }
  }
}))

import { HOST_WORKTREE_WAIT_MS, waitForHostWorktree } from './wait-for-host-worktree'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  store.listeners.clear()
})

describe('waitForHostWorktree', () => {
  it('resolves at once when the row is already listed', async () => {
    await expect(waitForHostWorktree(() => 'wt')).resolves.toBe('wt')
    expect(store.listeners.size).toBe(0)
  })

  it('resolves when the row lands a moment later (the n48/n55 picker open)', async () => {
    let row: string | null = null
    const waiting = waitForHostWorktree(() => row)
    store.emit()
    row = 'cloud::/workspace/repo'
    store.emit()
    await expect(waiting).resolves.toBe('cloud::/workspace/repo')
    expect(store.listeners.size).toBe(0)
  })

  it('gives up after the bound, leaving nothing subscribed', async () => {
    const waiting = waitForHostWorktree(() => null)
    vi.advanceTimersByTime(HOST_WORKTREE_WAIT_MS)
    await expect(waiting).resolves.toBeNull()
    expect(store.listeners.size).toBe(0)
  })
})
