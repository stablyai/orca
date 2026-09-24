import { describe, expect, it } from 'vitest'
import {
  formatLiveWorktreePidBlocker,
  isLiveWorktreePidBlocker,
  qualifiesForFinishedWorktreeForceCleanup,
  readLiveWorktreePids
} from './finished-worktree-force-cleanup'

const base = {
  hasAutomationProvenance: false,
  workspaceStatus: 'in-progress',
  commitsAheadOfDefault: null as number | null,
  hasLiveUiVisibleSession: false
}

describe('qualifiesForFinishedWorktreeForceCleanup', () => {
  it('keeps a user worktree with a visible session fail-closed', () => {
    expect(
      qualifiesForFinishedWorktreeForceCleanup({
        ...base,
        workspaceStatus: 'completed',
        commitsAheadOfDefault: 0,
        hasLiveUiVisibleSession: true
      })
    ).toBe(false)
  })

  it('allows an automation worktree even when a session is still visible', () => {
    expect(
      qualifiesForFinishedWorktreeForceCleanup({
        ...base,
        hasAutomationProvenance: true,
        hasLiveUiVisibleSession: true
      })
    ).toBe(true)
  })

  it('allows a completed worktree and an ahead=0 worktree without a visible session', () => {
    expect(
      qualifiesForFinishedWorktreeForceCleanup({
        ...base,
        workspaceStatus: 'completed'
      })
    ).toBe(true)
    expect(
      qualifiesForFinishedWorktreeForceCleanup({
        ...base,
        commitsAheadOfDefault: 0
      })
    ).toBe(true)
  })

  it('does not treat an unknown ahead count as finished', () => {
    expect(qualifiesForFinishedWorktreeForceCleanup(base)).toBe(false)
    expect(
      qualifiesForFinishedWorktreeForceCleanup({
        ...base,
        commitsAheadOfDefault: 2
      })
    ).toBe(false)
  })
})

describe('formatLiveWorktreePidBlocker', () => {
  it('names the pids and never says the workspace selector is gone', () => {
    const message = formatLiveWorktreePidBlocker([4242, 4243])
    expect(message).toBe('cannot delete because PID 4242, 4243 still running in this worktree')
    expect(message).not.toContain('selector_not_found')
    expect(isLiveWorktreePidBlocker(message)).toBe(true)
    expect(readLiveWorktreePids(message)).toBe('4242, 4243')
  })
})
