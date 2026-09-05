/**
 * The repair lane must not become worse than the bug it fixes: a publisher that keeps re-sending a
 * retired epoch would otherwise drive an unbounded refetch loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const refreshLocalStructuredSessionTabs = vi.fn(
  async (_expectedGeneration?: number, _options?: { authoritative?: boolean }) => []
)

vi.mock('./inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: (
    expectedGeneration?: number,
    options?: { authoritative?: boolean }
  ) => refreshLocalStructuredSessionTabs(expectedGeneration, options),
  restoreLocalStructuredSessionTabsOnce: vi.fn()
}))

const { localStructuredSessionEpochHistoryByWorktree } =
  await import('./inventory-generation-fence')
const { scheduleRetiredEpochRepair, resetRetiredEpochRepairsForTests } =
  await import('./retired-epoch-repair')

const WORKTREE = 'folder:ws-1'
const EPOCH = 'renderer:53c8f87d'

function markRetired(): void {
  localStructuredSessionEpochHistoryByWorktree.set(WORKTREE, {
    current: 'headless:pty-backed:x',
    retired: [EPOCH]
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  refreshLocalStructuredSessionTabs.mockClear()
  resetRetiredEpochRepairsForTests()
  localStructuredSessionEpochHistoryByWorktree.clear()
})

afterEach(() => {
  resetRetiredEpochRepairsForTests()
  localStructuredSessionEpochHistoryByWorktree.clear()
  vi.useRealTimers()
})

describe('retired-epoch repair scheduling', () => {
  it('asks the host authoritatively, once, for a burst of drops on one worktree', async () => {
    markRetired()

    scheduleRetiredEpochRepair(WORKTREE, EPOCH)
    scheduleRetiredEpochRepair(WORKTREE, EPOCH)
    scheduleRetiredEpochRepair(WORKTREE, EPOCH)
    expect(refreshLocalStructuredSessionTabs).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)

    expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(1)
    expect(refreshLocalStructuredSessionTabs.mock.calls[0]?.[1]).toEqual({ authoritative: true })
  })

  it('stops after a bounded number of attempts and says so', async () => {
    markRetired()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The epoch stays retired, so every refresh counts as a failed repair.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      scheduleRetiredEpochRepair(WORKTREE, EPOCH)
      await vi.advanceTimersByTimeAsync(5000)
    }

    expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(
      '[structured-session-tabs] gave up repairing a retired publication epoch',
      expect.objectContaining({ worktree: WORKTREE, publicationEpoch: EPOCH })
    )
    warn.mockRestore()
  })

  it('rearms once a repair actually revives the epoch', async () => {
    markRetired()
    refreshLocalStructuredSessionTabs.mockImplementation(async () => {
      localStructuredSessionEpochHistoryByWorktree.set(WORKTREE, {
        current: EPOCH,
        retired: ['headless:pty-backed:x']
      })
      return []
    })

    scheduleRetiredEpochRepair(WORKTREE, EPOCH)
    await vi.advanceTimersByTimeAsync(300)
    expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(1)

    // A later, unrelated drop is not starved by the earlier attempt count.
    markRetired()
    scheduleRetiredEpochRepair(WORKTREE, EPOCH)
    await vi.advanceTimersByTimeAsync(300)

    expect(refreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(2)
  })
})
