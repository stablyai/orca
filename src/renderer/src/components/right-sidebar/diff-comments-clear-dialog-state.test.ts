import { describe, expect, it } from 'vitest'
import {
  resolvePendingDiffCommentsClear,
  type PendingDiffCommentsClear
} from './source-control/notes/diff-comments-clear-dialog-state'

const allPending: PendingDiffCommentsClear = { kind: 'all', worktreeId: 'wt-1' }
const filePending: PendingDiffCommentsClear = {
  kind: 'file',
  worktreeId: 'wt-1',
  filePath: 'src/app.tsx'
}

describe('diff comments clear dialog state', () => {
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
})
