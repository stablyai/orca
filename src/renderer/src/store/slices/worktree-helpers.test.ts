import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { applyWorktreeUpdates } from './worktree-helpers'

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/workspace/repo',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('applyWorktreeUpdates', () => {
  it('only updates the repo bucket encoded in the worktree id', () => {
    const target = makeWorktree({
      id: 'repo-a::/Users/alice/project',
      repoId: 'repo-a',
      displayName: 'Project A'
    })
    const samePathDifferentProject = makeWorktree({
      id: 'repo-a::/Users/alice/project',
      repoId: 'repo-b',
      displayName: 'Project B'
    })

    const result = applyWorktreeUpdates(
      {
        'repo-a': [target],
        'repo-b': [samePathDifferentProject]
      },
      target.id,
      { displayName: 'Renamed A' }
    )

    expect(result['repo-a']?.[0]?.displayName).toBe('Renamed A')
    expect(result['repo-b']?.[0]).toBe(samePathDifferentProject)
    expect(result['repo-b']?.[0]?.displayName).toBe('Project B')
  })
})
