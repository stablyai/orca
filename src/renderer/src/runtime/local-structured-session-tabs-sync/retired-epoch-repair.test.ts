/**
 * The repair lane must not become worse than the bug it fixes: a publisher that keeps re-sending a
 * retired epoch would otherwise drive an unbounded refetch loop, and a cap that never decays would
 * hide a chat tab for the renderer's lifetime after a run of transient RPC failures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localStructuredSessionEpochHistoryByWorktree } from './inventory-generation-fence'
import {
  forgetRetiredEpochRepairsOutside,
  resetRetiredEpochRepairsForTests,
  scheduleRetiredEpochRepair
} from './retired-epoch-repair'

const WORKTREE = 'folder:ws-1'
const EPOCH = 'renderer:53c8f87d'

const runRepair = vi.fn(async (_generation: number) => undefined)

function markRetired(): void {
  localStructuredSessionEpochHistoryByWorktree.set(WORKTREE, {
    current: 'headless:pty-backed:x',
    retired: [EPOCH]
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  runRepair.mockReset()
  runRepair.mockImplementation(async () => undefined)
  resetRetiredEpochRepairsForTests()
  localStructuredSessionEpochHistoryByWorktree.clear()
})

afterEach(() => {
  resetRetiredEpochRepairsForTests()
  localStructuredSessionEpochHistoryByWorktree.clear()
  vi.useRealTimers()
})

describe('retired-epoch repair scheduling', () => {
  it('asks the host once for a burst of drops on one worktree', async () => {
    markRetired()

    scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)
    scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)
    scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)
    expect(runRepair).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)

    expect(runRepair).toHaveBeenCalledTimes(1)
  })

  it('stops after a bounded number of attempts and says so', async () => {
    markRetired()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The epoch stays retired, so every refresh counts as a failed repair.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)
      await vi.advanceTimersByTimeAsync(5000)
    }

    expect(runRepair).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(
      '[structured-session-tabs] retired publication epoch still unrepaired',
      expect.objectContaining({ worktree: WORKTREE, publicationEpoch: EPOCH })
    )
    warn.mockRestore()
  })

  it('decays the cap instead of latching, so a later drop is still repairable', async () => {
    markRetired()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (let attempt = 0; attempt < 4; attempt += 1) {
      scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(runRepair).toHaveBeenCalledTimes(3)

    // A quiet minute later the worktree gets its budget back rather than staying hidden forever.
    await vi.advanceTimersByTimeAsync(60_000)
    scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)
    await vi.advanceTimersByTimeAsync(300)

    expect(runRepair).toHaveBeenCalledTimes(4)
  })

  it('rearms once a repair actually revives the epoch', async () => {
    markRetired()
    runRepair.mockImplementation(async () => {
      localStructuredSessionEpochHistoryByWorktree.set(WORKTREE, {
        current: EPOCH,
        retired: ['headless:pty-backed:x']
      })
    })

    scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)
    await vi.advanceTimersByTimeAsync(300)
    expect(runRepair).toHaveBeenCalledTimes(1)

    markRetired()
    scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)
    await vi.advanceTimersByTimeAsync(300)

    expect(runRepair).toHaveBeenCalledTimes(2)
  })

  it('forgets repair state for worktrees that no longer exist', async () => {
    markRetired()
    scheduleRetiredEpochRepair(WORKTREE, EPOCH, runRepair)

    forgetRetiredEpochRepairsOutside(new Set(['folder:other']))
    await vi.advanceTimersByTimeAsync(5000)

    // The pending refetch for the vanished worktree is cancelled, not merely orphaned.
    expect(runRepair).not.toHaveBeenCalled()
  })
})
