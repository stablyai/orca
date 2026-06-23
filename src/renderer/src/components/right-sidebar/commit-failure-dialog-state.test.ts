import { describe, expect, it } from 'vitest'
import {
  shouldShowCommitFailureDialog,
  syncCommitFailureDialogState,
  type CommitFailureDialogState
} from './commit-failure-dialog-state'

describe('commit failure dialog state', () => {
  it('keeps an open dialog visible when a new detailed error arrives for the same worktree', () => {
    const state: CommitFailureDialogState = { worktreeKey: 'wt-1', open: true }

    expect(syncCommitFailureDialogState(state, 'wt-1', true)).toBe(state)
    expect(shouldShowCommitFailureDialog(state, 'wt-1', true)).toBe(true)
  })

  it('closes the dialog when the failure moves to another worktree', () => {
    expect(syncCommitFailureDialogState({ worktreeKey: 'wt-1', open: true }, 'wt-2', true)).toEqual(
      {
        worktreeKey: 'wt-2',
        open: false
      }
    )
  })

  it('closes the dialog when the latest failure no longer has expanded details', () => {
    const next = syncCommitFailureDialogState({ worktreeKey: 'wt-1', open: true }, 'wt-1', false)

    expect(next).toEqual({ worktreeKey: 'wt-1', open: false })
    expect(shouldShowCommitFailureDialog(next, 'wt-1', false)).toBe(false)
  })
})
