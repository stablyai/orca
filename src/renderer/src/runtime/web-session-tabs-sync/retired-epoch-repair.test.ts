/**
 * The repair lane must not become worse than the bug it fixes: a publisher that keeps re-sending a
 * retired epoch would otherwise drive an unbounded refetch loop, and a cap that never decays would
 * hide host tabs for the client's lifetime after a run of transient RPC failures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsTrackingGenerationByEnvironment
} from './state'
import { clearWebSessionTabsTrackingForEnvironment } from './tracking-lifecycle'
import {
  forgetWebRetiredEpochRepairsForWorktree,
  forgetWebRetiredEpochRepairsOutside,
  resetWebRetiredEpochRepairsForTests,
  scheduleWebRetiredEpochRepair
} from './retired-epoch-repair'

const ENV = 'remote-runtime'
const WORKTREE = 'repo::/worktree'
const EPOCH = 'renderer:R:client-navigation'
const KEY = `${ENV}:${WORKTREE}`

const runRepair = vi.fn(async () => undefined)

function markRetired(): void {
  sessionTabsPublicationEpochHistoryByWorktree.set(KEY, {
    current: 'headless:H:client-navigation',
    retired: [EPOCH]
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  runRepair.mockReset()
  runRepair.mockImplementation(async () => undefined)
  resetWebRetiredEpochRepairsForTests()
  sessionTabsPublicationEpochHistoryByWorktree.clear()
})

afterEach(() => {
  resetWebRetiredEpochRepairsForTests()
  sessionTabsPublicationEpochHistoryByWorktree.clear()
  vi.useRealTimers()
})

describe('web retired-epoch repair scheduling', () => {
  it('asks the host once for a burst of drops on one worktree', async () => {
    markRetired()

    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    expect(runRepair).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)

    expect(runRepair).toHaveBeenCalledTimes(1)
  })

  it('stops after a bounded number of attempts and says so', async () => {
    markRetired()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The epoch stays retired, so every refresh counts as a failed repair.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
      await vi.advanceTimersByTimeAsync(5000)
    }

    expect(runRepair).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(
      '[web-session-tabs] retired publication epoch still unrepaired',
      expect.objectContaining({ worktree: WORKTREE, publicationEpoch: EPOCH })
    )
    warn.mockRestore()
  })

  it('decays the cap instead of latching, so a later drop is still repairable', async () => {
    markRetired()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (let attempt = 0; attempt < 4; attempt += 1) {
      scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(runRepair).toHaveBeenCalledTimes(3)

    // A quiet minute later the worktree gets its budget back rather than staying hidden forever.
    await vi.advanceTimersByTimeAsync(60_000)
    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    await vi.advanceTimersByTimeAsync(300)

    expect(runRepair).toHaveBeenCalledTimes(4)
  })

  it('rearms once a repair actually revives the epoch', async () => {
    markRetired()
    runRepair.mockImplementation(async () => {
      sessionTabsPublicationEpochHistoryByWorktree.set(KEY, {
        current: EPOCH,
        retired: ['headless:H:client-navigation']
      })
    })

    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    await vi.advanceTimersByTimeAsync(300)
    expect(runRepair).toHaveBeenCalledTimes(1)

    markRetired()
    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    await vi.advanceTimersByTimeAsync(300)

    expect(runRepair).toHaveBeenCalledTimes(2)
  })

  it('retries on transient failure while generation and budget remain', async () => {
    markRetired()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runRepair
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined)

    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    await vi.advanceTimersByTimeAsync(300)
    expect(runRepair).toHaveBeenCalledTimes(1)

    // Catch path schedules the next bounded attempt.
    await vi.advanceTimersByTimeAsync(5000)
    expect(runRepair).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('does not fire after the tracking generation advances', async () => {
    markRetired()

    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    // Bump generation without clearing RepairState, so the timer fence alone must drop the run.
    sessionTabsTrackingGenerationByEnvironment.set(
      ENV,
      (sessionTabsTrackingGenerationByEnvironment.get(ENV) ?? 0) + 1
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(runRepair).not.toHaveBeenCalled()
  })

  it('forgets repair state for worktrees that no longer exist', async () => {
    markRetired()
    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)

    forgetWebRetiredEpochRepairsOutside(ENV, new Set(['repo::/other']))
    await vi.advanceTimersByTimeAsync(5000)

    // The pending refetch for the vanished worktree is cancelled, not merely orphaned.
    expect(runRepair).not.toHaveBeenCalled()
  })

  it('clears repair state for a worktree and for the whole environment', async () => {
    markRetired()
    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    forgetWebRetiredEpochRepairsForWorktree(ENV, WORKTREE)
    await vi.advanceTimersByTimeAsync(5000)
    expect(runRepair).not.toHaveBeenCalled()

    scheduleWebRetiredEpochRepair(ENV, WORKTREE, EPOCH, runRepair)
    clearWebSessionTabsTrackingForEnvironment(ENV)
    await vi.advanceTimersByTimeAsync(5000)
    expect(runRepair).not.toHaveBeenCalled()
  })
})
