import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeRenameGraceRetention } from './worktree-rename-grace-retention'

describe('worktree rename grace retention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sweeps expired IDs even when no async refresh completes', async () => {
    const retention = new WorktreeRenameGraceRetention()
    retention.remember(['old-id', 'new-id'], 2000)

    expect(retention.evidence().entries).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(retention.evidence()).toEqual({ entries: 0, idBytes: 0 })
    retention.dispose()
  })

  it('bounds retained IDs and suppresses destructive purges during overflow', () => {
    const retention = new WorktreeRenameGraceRetention({
      maxEntries: 2,
      maxIdBytes: 8,
      maxTotalIdBytes: 16
    })

    retention.remember(['old-a', 'new-a', 'overflow'], 2000)

    expect(retention.evidence()).toEqual({
      entries: 2,
      idBytes: 10,
      suppressAllUntil: 2000
    })
    expect(retention.protects('untracked', 1500)).toBe(true)
    expect(retention.protects('untracked', 2000)).toBe(false)
    retention.dispose()
  })

  it('does not retain an oversized worktree ID', () => {
    const retention = new WorktreeRenameGraceRetention({
      maxEntries: 2,
      maxIdBytes: 4,
      maxTotalIdBytes: 8
    })

    retention.remember(['oversized'], 2000)

    expect(retention.evidence()).toEqual({
      entries: 0,
      idBytes: 0,
      suppressAllUntil: 2000
    })
    retention.dispose()
  })
})
