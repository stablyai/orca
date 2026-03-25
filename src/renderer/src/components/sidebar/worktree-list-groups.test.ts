import { describe, expect, it } from 'vitest'
import { getPRGroupKey } from './worktree-list-groups'
import type { Repo, Worktree } from '../../../../shared/types'

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/orca',
  displayName: 'orca',
  badgeColor: '#000000',
  addedAt: 0
}

const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/tmp/orca-feature',
  branch: 'refs/heads/feature/super-critical',
  head: 'abc123',
  isBare: false,
  linkedIssue: null,
  linkedPR: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  displayName: 'feature/super-critical',
  sortOrder: 0
}

describe('getPRGroupKey', () => {
  it('puts merged PRs in the done group', () => {
    const repoMap = new Map([[repo.id, repo]])
    const prCache = {
      '/tmp/orca::feature/super-critical': {
        data: { state: 'merged' }
      }
    }

    expect(getPRGroupKey(worktree, repoMap, prCache)).toBe('done')
  })
})
