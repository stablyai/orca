import { describe, expect, it } from 'vitest'
import { resolveCommitFailureDialogState } from './commit-failure-dialog-state'

describe('resolveCommitFailureDialogState', () => {
  it('keeps the dialog state when the commit failure identity still matches', () => {
    const state = { identity: 'wt-1:error-a', open: true }

    expect(resolveCommitFailureDialogState(state, 'wt-1:error-a')).toBe(state)
  })

  it('closes the dialog when the active commit failure identity changes', () => {
    expect(
      resolveCommitFailureDialogState({ identity: 'wt-1:error-a', open: true }, 'wt-1:')
    ).toEqual({
      identity: 'wt-1:',
      open: false
    })
  })

  it('does not reopen an older failure when its identity comes back later', () => {
    const cleared = resolveCommitFailureDialogState(
      { identity: 'wt-1:error-a', open: true },
      'wt-1:error-b'
    )

    expect(resolveCommitFailureDialogState(cleared, 'wt-1:error-a')).toEqual({
      identity: 'wt-1:error-a',
      open: false
    })
  })
})
