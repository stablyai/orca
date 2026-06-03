import { describe, expect, it } from 'vitest'
import { clearRemoteActionErrorsForCompletedConflictOperations } from './SourceControl'

describe('SourceControl remote action error reconciliation', () => {
  it('clears a rebase failure after git status observes the rebase completed', () => {
    const errors = {
      'wt-1': { kind: 'rebase' as const, message: 'Rebase failed. Could not apply abc123' }
    }

    expect(
      clearRemoteActionErrorsForCompletedConflictOperations({
        remoteActionErrors: errors,
        previousConflictOperations: { 'wt-1': 'rebase' },
        currentConflictOperations: { 'wt-1': 'unknown' }
      })
    ).toEqual({ 'wt-1': null })
  })

  it('keeps a rebase failure while the rebase is still in progress', () => {
    const errors = {
      'wt-1': { kind: 'rebase' as const, message: 'Rebase failed. Could not apply abc123' }
    }

    expect(
      clearRemoteActionErrorsForCompletedConflictOperations({
        remoteActionErrors: errors,
        previousConflictOperations: { 'wt-1': 'rebase' },
        currentConflictOperations: { 'wt-1': 'rebase' }
      })
    ).toBe(errors)
  })

  it('keeps immediate rebase failures that never entered a rebase operation', () => {
    const errors = {
      'wt-1': { kind: 'rebase' as const, message: 'Rebase blocked - commit first.' }
    }

    expect(
      clearRemoteActionErrorsForCompletedConflictOperations({
        remoteActionErrors: errors,
        previousConflictOperations: { 'wt-1': 'unknown' },
        currentConflictOperations: { 'wt-1': 'unknown' }
      })
    ).toBe(errors)
  })

  it('clears pull and sync conflict errors after their merge operation completes', () => {
    const errors = {
      'wt-pull': { kind: 'pull' as const, message: 'Pull stopped with merge conflicts.' },
      'wt-sync': { kind: 'sync' as const, message: 'Sync stopped with merge conflicts.' },
      'wt-fetch': { kind: 'fetch' as const, message: 'Fetch failed. network timeout' }
    }

    expect(
      clearRemoteActionErrorsForCompletedConflictOperations({
        remoteActionErrors: errors,
        previousConflictOperations: {
          'wt-pull': 'merge',
          'wt-sync': 'merge',
          'wt-fetch': 'merge'
        },
        currentConflictOperations: {
          'wt-pull': 'unknown',
          'wt-sync': 'unknown',
          'wt-fetch': 'unknown'
        }
      })
    ).toEqual({
      'wt-pull': null,
      'wt-sync': null,
      'wt-fetch': errors['wt-fetch']
    })
  })
})
