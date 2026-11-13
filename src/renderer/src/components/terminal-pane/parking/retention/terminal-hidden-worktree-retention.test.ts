import { describe, expect, it } from 'vitest'
import {
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
  selectRetentionForceParkedTerminalWorktrees,
  type TerminalWorktreeRetentionCandidate
} from './terminal-hidden-worktree-retention'

describe('selectRetentionForceParkedTerminalWorktrees', () => {
  const nowMs = 5_000_000

  function retentionCandidate(
    worktreeId: string,
    hiddenSinceMs: number | null,
    partial: Partial<TerminalWorktreeRetentionCandidate> = {}
  ): TerminalWorktreeRetentionCandidate {
    return {
      worktreeId,
      hiddenSinceMs,
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      ordinaryParkingCovers: false,
      hasPendingSpawnWork: false,
      ...partial
    }
  }

  const base = {
    parkingEnabled: true,
    retentionBudgetEnabled: true,
    nowMs
  }

  // Last-active exemption applies only to cap; extending it to TTL retains a lone hidden worktree forever.
  it('force-parks the last-active candidate once it passes the TTL (the exemption bounds the cap, not the clock)', () => {
    const lone = [retentionCandidate('wt-lone', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS)]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees: lone })).toEqual(
      new Set(['wt-lone'])
    )
    const insideTtl = [
      retentionCandidate('wt-lone', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS + 1)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees: insideTtl })).toEqual(
      new Set()
    )
  })
})
