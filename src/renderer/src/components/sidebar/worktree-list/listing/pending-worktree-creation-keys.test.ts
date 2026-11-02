import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import {
  EMPTY_PENDING_WORKTREE_CREATION_KEYS,
  selectPendingWorktreeCreationKeys
} from './pending-worktree-creation-keys'

type PendingCreations = AppState['pendingWorktreeCreations']

function makePending(creationId: string, repoId: string): PendingCreations[string] {
  return {
    creationId,
    request: { repoId }
  } as unknown as PendingCreations[string]
}

describe('selectPendingWorktreeCreationKeys', () => {
  // The always-mounted sidebar reevaluates this selector on every store write.
  it('returns the shared frozen empty when nothing is pending', () => {
    const empty: PendingCreations = {}

    expect(selectPendingWorktreeCreationKeys(empty)).toBe(EMPTY_PENDING_WORKTREE_CREATION_KEYS)
    expect(selectPendingWorktreeCreationKeys({})).toBe(EMPTY_PENDING_WORKTREE_CREATION_KEYS)
    expect(selectPendingWorktreeCreationKeys(undefined)).toBe(EMPTY_PENDING_WORKTREE_CREATION_KEYS)
    expect(Object.isFrozen(EMPTY_PENDING_WORKTREE_CREATION_KEYS)).toBe(true)
  })

  it('builds the key list once per slice identity', () => {
    const pending: PendingCreations = {
      'creation-1': makePending('creation-1', 'repo with space')
    }

    const first = selectPendingWorktreeCreationKeys(pending)
    expect(first).toEqual(['creation-1 repo with space'])
    expect(selectPendingWorktreeCreationKeys(pending)).toBe(first)
  })
})
