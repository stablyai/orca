import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../../../shared/github/pull-requests/pull-request-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import {
  getWorktreeCardReviewCacheKeys,
  selectWorktreeCardReviewState
} from './worktree-card-review-resolution'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1
}
const worktree = makeWorktree({ id: 'repo-1::/fix', repoId: 'repo-1', head: 'head-1' })

function pr(overrides: Partial<PRInfo>): PRInfo {
  return {
    number: 7,
    title: 'Fix',
    state: 'open',
    url: 'https://example.com/pr/7',
    checksStatus: 'success',
    updatedAt: '2026-11-01T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha: 'head-1',
    ...overrides
  }
}

function stateWith(data: PRInfo | null): Parameters<typeof selectWorktreeCardReviewState>[0] {
  const { prCacheKey } = getWorktreeCardReviewCacheKeys(worktree, repo, null)
  return {
    settings: null,
    hostedReviewCache: {},
    prCache: { [prCacheKey]: { data, fetchedAt: 1 } }
  }
}

describe('selectWorktreeCardReviewState', () => {
  it("reads the branch PR's state the card shows", () => {
    expect(selectWorktreeCardReviewState(stateWith(pr({})), worktree, repo)).toBe('open')
    expect(selectWorktreeCardReviewState(stateWith(pr({ state: 'closed' })), worktree, repo)).toBe(
      'closed'
    )
    expect(selectWorktreeCardReviewState(stateWith(pr({ state: 'merged' })), worktree, repo)).toBe(
      'merged'
    )
  })

  it('is null with no PR', () => {
    expect(selectWorktreeCardReviewState(stateWith(null), worktree, repo)).toBeNull()
    expect(
      selectWorktreeCardReviewState(
        { settings: null, hostedReviewCache: {}, prCache: {} },
        worktree,
        repo
      )
    ).toBeNull()
  })

  it('drops a merged PR once the workspace has new commits past it', () => {
    const state = stateWith(pr({ state: 'merged', headSha: 'older' }))
    expect(selectWorktreeCardReviewState(state, worktree, repo)).toBeNull()
  })
})
