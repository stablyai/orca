import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../worktree/types'
import { deriveAiVaultWorkspaceScopePaths } from './ai-vault-scope-paths'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/orca',
    repoId: 'repo-1',
    displayName: 'orca',
    path: '/repo/orca',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    isMainWorktree: false,
    ...overrides
  }
}

describe('deriveAiVaultWorkspaceScopePaths', () => {
  it('drops a claimed prior path regardless of where the claimant sits in the list', () => {
    // Exclude the active workspace before indexing owners so duplicates cannot hide later claimants.
    const active = makeWorktree({
      id: 'repo-1::/repo/orca-renamed',
      path: '/repo/orca-renamed',
      priorWorktreeIds: ['repo-1::/repo/orca']
    })
    const claimant = makeWorktree({ id: 'repo-1::/repo/orca', path: '/repo/orca' })
    // Listing the active workspace at the prior path exposes first-writer-wins ownership bugs.
    const activeAtPriorPath = makeWorktree({ id: active.id, path: '/repo/orca' })

    for (const liveWorktrees of [
      [active, claimant],
      [claimant, active],
      [activeAtPriorPath, claimant],
      [claimant, activeAtPriorPath]
    ]) {
      expect(deriveAiVaultWorkspaceScopePaths(active, liveWorktrees)).toEqual([
        '/repo/orca-renamed'
      ])
    }
  })
})
