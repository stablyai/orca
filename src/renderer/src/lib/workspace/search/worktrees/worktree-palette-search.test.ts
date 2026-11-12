import { describe, expect, it } from 'vitest'
import { searchWorktrees } from './worktree-palette-search'
import '../../../../../../shared/palette-match/worktree-palette-query-bounds'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature/worktree-jump',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Jump Palette',
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

const repoMap = new Map<string, Repo>([
  [
    'repo-1',
    {
      id: 'repo-1',
      path: '/repo/orca',
      displayName: 'stablyai/orca',
      badgeColor: '#22c55e',
      addedAt: 0
    }
  ]
])

describe('worktree-palette-search', () => {
  it('finds a cloud workspace by its number and says why it matched', () => {
    const cloud = makeWorktree({ id: 'wt-cloud', displayName: 'Fix login' })
    const local = makeWorktree({ id: 'wt-local', displayName: 'Release 123 notes' })
    const cloudNumberByWorktreeId = new Map([['wt-cloud', 123]])
    for (const query of ['W-123', 'w123']) {
      const results = searchWorktrees([cloud, local], query, repoMap, { cloudNumberByWorktreeId })
      expect(results.map((r) => r.worktreeId)).toEqual(['wt-cloud'])
      expect(results[0]?.supportingText?.labelKind).toBe('cloudWorkspace')
      expect(results[0]?.supportingText?.text).toBe('W-123')
    }
    expect(
      searchWorktrees([cloud, local], '123', repoMap, { cloudNumberByWorktreeId }).map(
        (r) => r.worktreeId
      )
    ).toContain('wt-cloud')
  })
})
