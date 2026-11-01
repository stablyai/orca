import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildAddRepoExistingWorkspacesDetectedEvent } from './add-repo-existing-workspaces-telemetry'

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo::/repo',
    repoId: 'repo',
    path: '/repo',
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('add repo existing workspace telemetry', () => {
  it('sorts without crashing when a detected worktree has no displayName (crash 99657ab1)', () => {
    // Equal activity forces the name tie-break that crashed on undefined runtime names.
    expect(() =>
      buildAddRepoExistingWorkspacesDetectedEvent('local_folder_picker', [
        worktree({ id: 'repo::/a', path: '/a', displayName: 'Alpha', lastActivityAt: 5 }),
        worktree({
          id: 'repo::/b',
          path: '/b',
          isMainWorktree: false,
          displayName: undefined as unknown as string,
          lastActivityAt: 5
        })
      ])
    ).not.toThrow()
  })
})
