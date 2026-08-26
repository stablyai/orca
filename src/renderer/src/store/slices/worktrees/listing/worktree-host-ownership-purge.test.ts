import { describe, expect, it } from 'vitest'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import { getRemovedWorktreeIdsAfterAuthoritativeScan } from './worktree-host-ownership'

const repo = {
  id: 'repo-1',
  path: 'D:/Agentic/game2',
  displayName: 'game2',
  badgeColor: 'blue',
  addedAt: 1
}

const WINDOWS_BACKSLASH_ID =
  'repo-1::D:' + String.fromCharCode(92) + 'Agentic' + String.fromCharCode(92) + 'game2'
const WINDOWS_FORWARD_SLASH_ID = 'repo-1::D:/Agentic/game2'

function stateWithKnownDetected(worktreeIds: string[]) {
  return {
    repos: [repo],
    detectedWorktreesByRepo: {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        worktrees: worktreeIds.map((id) => ({ id }))
      }
    },
    worktreesByRepo: {},
    hasHydratedWorktreePurge: true
  }
}

function authoritativeScan(worktreeIds: string[]): DetectedWorktreeListResult {
  return {
    repoId: 'repo-1',
    authoritative: true,
    source: 'git',
    worktrees: worktreeIds.map((id) => ({ id, ownership: 'orca-managed', selectedCheckout: false, visible: true }))
  } as unknown as DetectedWorktreeListResult
}

describe('getRemovedWorktreeIdsAfterAuthoritativeScan', () => {
  it('does not purge a known worktree whose id differs only by path separator spelling (#15598)', () => {
    const state = stateWithKnownDetected([WINDOWS_BACKSLASH_ID])

    const removed = getRemovedWorktreeIdsAfterAuthoritativeScan(
      state as never,
      'repo-1',
      authoritativeScan([WINDOWS_FORWARD_SLASH_ID]),
      'local'
    )

    // The backslash spelling was written by an earlier registration of the same
    // checkout; purging it force-kills the terminals still bound to it.
    expect(removed).toEqual([])
  })

  it('still purges a worktree that is genuinely gone from the scan', () => {
    const state = stateWithKnownDetected([WINDOWS_FORWARD_SLASH_ID, 'repo-1::D:/Agentic/gone'])

    const removed = getRemovedWorktreeIdsAfterAuthoritativeScan(
      state as never,
      'repo-1',
      authoritativeScan([WINDOWS_FORWARD_SLASH_ID]),
      'local'
    )

    expect(removed).toEqual(['repo-1::D:/Agentic/gone'])
  })

  it('still purges separator variants when the checkout is no longer scanned at all', () => {
    const state = stateWithKnownDetected([WINDOWS_BACKSLASH_ID])

    const removed = getRemovedWorktreeIdsAfterAuthoritativeScan(
      state as never,
      'repo-1',
      authoritativeScan(['repo-1::D:/Agentic/other-checkout']),
      'local'
    )

    expect(removed).toEqual([WINDOWS_BACKSLASH_ID])
  })
})
