import { describe, expect, it } from 'vitest'
import {
  countPendingDiffCommentsClear,
  formatPendingDiffCommentsClearDescription,
  resolvePendingDiffCommentsClear,
  type PendingDiffCommentsClear
} from './diff-comments-clear-dialog-state'

const allPending: PendingDiffCommentsClear = { kind: 'all', worktreeId: 'wt-1' }
const filePending: PendingDiffCommentsClear = {
  kind: 'file',
  worktreeId: 'wt-1',
  filePath: 'src/app.tsx'
}

describe('diff comments clear dialog state', () => {
  it('counts all or per-file pending notes for the active worktree', () => {
    const comments = [
      { filePath: 'src/app.tsx' },
      { filePath: 'src/app.tsx' },
      { filePath: 'src/other.ts' }
    ]

    expect(countPendingDiffCommentsClear(allPending, 'wt-1', comments)).toBe(3)
    expect(countPendingDiffCommentsClear(filePending, 'wt-1', comments)).toBe(2)
  })

  it('returns zero when the pending confirmation belongs to another worktree', () => {
    expect(countPendingDiffCommentsClear(allPending, 'wt-2', [{ filePath: 'src/app.tsx' }])).toBe(0)
  })

  it('clears stale confirmations before rendering the dialog', () => {
    expect(
      resolvePendingDiffCommentsClear({
        pending: allPending,
        activeWorktreeId: 'wt-2',
        pendingCount: 1,
        isClearing: false
      })
    ).toBeNull()
    expect(
      resolvePendingDiffCommentsClear({
        pending: filePending,
        activeWorktreeId: 'wt-1',
        pendingCount: 0,
        isClearing: false
      })
    ).toBeNull()
  })

  it('keeps the confirmation stable while a clear request is in flight', () => {
    expect(
      resolvePendingDiffCommentsClear({
        pending: filePending,
        activeWorktreeId: 'wt-2',
        pendingCount: 0,
        isClearing: true
      })
    ).toBe(filePending)
  })

  it('formats confirmation copy from the resolved pending state', () => {
    expect(formatPendingDiffCommentsClearDescription(allPending, 1)).toBe(
      'Clear 1 note from this workspace?'
    )
    expect(formatPendingDiffCommentsClearDescription(filePending, 2)).toBe(
      'Clear 2 notes from src/app.tsx?'
    )
    expect(formatPendingDiffCommentsClearDescription(null, 0)).toBe('')
  })
})
