import { describe, expect, it } from 'vitest'
import type { DiffCommentOwner } from '@/store/diff-comment-owner'
import {
  resolvePendingDiffCommentsClear,
  type PendingDiffCommentsClear
} from './source-control/notes/diff-comments-clear-dialog-state'

const owner: DiffCommentOwner = {
  kind: 'worktree',
  worktreeId: 'wt-1',
  authority: { endpoint: { kind: 'self' }, at: 'local' }
}
const allPending: PendingDiffCommentsClear = { kind: 'all', worktreeId: 'wt-1', owner, count: 1 }
const filePending: PendingDiffCommentsClear = {
  kind: 'file',
  owner,
  worktreeId: 'wt-1',
  filePath: 'src/app.tsx',
  count: 1
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
