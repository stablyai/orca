import { describe, expect, it } from 'vitest'
import {
  COMPLETED_WORKSPACE_STATUS_ID,
  DEFAULT_WORKSPACE_STATUS_ID,
  MAIN_WORKTREE_WORKSPACE_STATUS_ID
} from '../workspace-statuses'
import {
  settleWorkspaceStatus,
  shouldPersistSettledWorkspaceStatus,
  type WorkspaceStatusSettlementInput
} from './workspace-status-settlement'

function input(
  overrides: Partial<WorkspaceStatusSettlementInput> = {}
): WorkspaceStatusSettlementInput {
  return {
    isMainWorktree: false,
    storedStatus: DEFAULT_WORKSPACE_STATUS_ID,
    uniqueCommitCount: null,
    linkedReviewState: null,
    linkedTaskSignal: 'none',
    ...overrides
  }
}

describe('settleWorkspaceStatus', () => {
  it('moves a non-main worktree to completed when HEAD is contained in the default branch', () => {
    expect(settleWorkspaceStatus(input({ uniqueCommitCount: 0 }))).toBe(
      COMPLETED_WORKSPACE_STATUS_ID
    )
  })

  it('does not flip while unique commits exist and no explicit finish signal is known', () => {
    expect(settleWorkspaceStatus(input({ uniqueCommitCount: 3 }))).toBe(DEFAULT_WORKSPACE_STATUS_ID)
    expect(settleWorkspaceStatus(input({ uniqueCommitCount: null }))).toBe(
      DEFAULT_WORKSPACE_STATUS_ID
    )
  })

  it('leaves in-progress when the linked review is merged or closed even if unique commits remain', () => {
    expect(
      settleWorkspaceStatus(input({ uniqueCommitCount: 4, linkedReviewState: 'merged' }))
    ).toBe(COMPLETED_WORKSPACE_STATUS_ID)
    expect(
      settleWorkspaceStatus(input({ uniqueCommitCount: 4, linkedReviewState: 'closed' }))
    ).toBe(COMPLETED_WORKSPACE_STATUS_ID)
  })

  it('keeps in-progress when the linked review is still open or its state is unverified', () => {
    expect(settleWorkspaceStatus(input({ linkedReviewState: 'open', uniqueCommitCount: 2 }))).toBe(
      DEFAULT_WORKSPACE_STATUS_ID
    )
    expect(settleWorkspaceStatus(input({ linkedReviewState: 'draft', uniqueCommitCount: 2 }))).toBe(
      DEFAULT_WORKSPACE_STATUS_ID
    )
    expect(
      settleWorkspaceStatus(input({ linkedReviewState: 'unknown', uniqueCommitCount: 2 }))
    ).toBe(DEFAULT_WORKSPACE_STATUS_ID)
  })

  it('leaves in-progress when every linked orchestration task is completed or failed', () => {
    expect(
      settleWorkspaceStatus(input({ linkedTaskSignal: 'finished', uniqueCommitCount: 2 }))
    ).toBe(COMPLETED_WORKSPACE_STATUS_ID)
  })

  it('does not treat an active or unreadable task as finished', () => {
    expect(settleWorkspaceStatus(input({ linkedTaskSignal: 'active', uniqueCommitCount: 2 }))).toBe(
      DEFAULT_WORKSPACE_STATUS_ID
    )
    expect(
      settleWorkspaceStatus(input({ linkedTaskSignal: 'unknown', uniqueCommitCount: 2 }))
    ).toBe(DEFAULT_WORKSPACE_STATUS_ID)
  })

  it('does not override a status the user set to something other than in-progress', () => {
    expect(
      settleWorkspaceStatus(
        input({ storedStatus: 'in-review', uniqueCommitCount: 0, linkedReviewState: 'merged' })
      )
    ).toBe('in-review')
    expect(
      settleWorkspaceStatus(input({ storedStatus: 'todo', linkedTaskSignal: 'finished' }))
    ).toBe('todo')
  })

  it('publishes a non-task status for main worktrees', () => {
    expect(
      settleWorkspaceStatus(
        input({
          isMainWorktree: true,
          storedStatus: DEFAULT_WORKSPACE_STATUS_ID,
          uniqueCommitCount: 0,
          linkedReviewState: 'merged',
          linkedTaskSignal: 'finished'
        })
      )
    ).toBe(MAIN_WORKTREE_WORKSPACE_STATUS_ID)
  })

  it('persists a completion or a main checkout, and not an unchanged in-progress row', () => {
    expect(
      shouldPersistSettledWorkspaceStatus({
        isMainWorktree: false,
        storedStatus: DEFAULT_WORKSPACE_STATUS_ID,
        nextStatus: COMPLETED_WORKSPACE_STATUS_ID
      })
    ).toBe(true)
    expect(
      shouldPersistSettledWorkspaceStatus({
        isMainWorktree: true,
        storedStatus: DEFAULT_WORKSPACE_STATUS_ID,
        nextStatus: MAIN_WORKTREE_WORKSPACE_STATUS_ID
      })
    ).toBe(true)
    expect(
      shouldPersistSettledWorkspaceStatus({
        isMainWorktree: false,
        storedStatus: 'in-review',
        nextStatus: COMPLETED_WORKSPACE_STATUS_ID
      })
    ).toBe(false)
    expect(
      shouldPersistSettledWorkspaceStatus({
        isMainWorktree: false,
        storedStatus: undefined,
        nextStatus: DEFAULT_WORKSPACE_STATUS_ID
      })
    ).toBe(false)
  })
})
