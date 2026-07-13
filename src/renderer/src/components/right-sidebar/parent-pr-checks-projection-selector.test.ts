import { describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Repo, Worktree } from '../../../../shared/types'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { buildParentPrChecksProjection } from './parent-pr-checks-rows'
import { createParentPrChecksProjectionSelector } from './parent-pr-checks-projection-selector'

function repo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git'
  }
}

function worktree(index: number): Worktree {
  return {
    id: `worktree-${index}`,
    path: `/worktrees/${index}`,
    head: `head-${index}`,
    branch: `refs/heads/feature-${index}`,
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: `Worktree ${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: index,
    lastActivityAt: index
  }
}

function review(number: number): HostedReviewInfo {
  return {
    provider: 'github',
    number,
    title: `Review ${number}`,
    state: 'open',
    url: `https://example.test/review/${number}`,
    status: 'success',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: 'head-0'
  }
}

describe('parent PR checks projection selector', () => {
  it('does not inspect tracked keys when cache map references are unchanged', () => {
    const cacheRead = vi.fn()
    const observedCache = new Proxy(
      {},
      {
        get: (target, property, receiver) => {
          cacheRead(property)
          return Reflect.get(target, property, receiver)
        }
      }
    )
    const buildProjection = vi.fn(buildParentPrChecksProjection)
    const select = createParentPrChecksProjectionSelector(
      { worktrees: [worktree(0)], repos: [repo()], settings: null, refreshOutcomes: new Map() },
      buildProjection
    )
    const state = {
      hostedReviewCache: observedCache,
      prCache: observedCache,
      checksCache: observedCache
    }
    const projection = select(state)
    cacheRead.mockClear()

    for (let notification = 0; notification < 1_000; notification += 1) {
      expect(select(state)).toBe(projection)
    }

    expect(cacheRead).not.toHaveBeenCalled()
    expect(buildProjection).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated global review-cache replacements at scale', () => {
    const worktrees = Array.from({ length: 100 }, (_, index) => worktree(index))
    const buildProjection = vi.fn(buildParentPrChecksProjection)
    const select = createParentPrChecksProjectionSelector(
      { worktrees, repos: [repo()], settings: null, refreshOutcomes: new Map() },
      buildProjection
    )
    let state = { hostedReviewCache: {}, prCache: {}, checksCache: {} }
    let projection = select(state)
    let wholeMapInvalidations = 0
    let scopedInvalidations = 0

    for (let write = 0; write < 200; write += 1) {
      const previous = state
      state = {
        ...state,
        hostedReviewCache: {
          ...state.hostedReviewCache,
          [`unrelated-hosted-${write}`]: { data: null, fetchedAt: write }
        }
      }
      wholeMapInvalidations += Number(previous.hostedReviewCache !== state.hostedReviewCache)
      const next = select(state)
      scopedInvalidations += Number(projection !== next)
      projection = next
    }
    for (let write = 0; write < 200; write += 1) {
      const previous = state
      state = {
        ...state,
        prCache: {
          ...state.prCache,
          [`unrelated-pr-${write}`]: { data: null, fetchedAt: write }
        }
      }
      wholeMapInvalidations += Number(previous.prCache !== state.prCache)
      const next = select(state)
      scopedInvalidations += Number(projection !== next)
      projection = next
    }
    for (let write = 0; write < 200; write += 1) {
      const previous = state
      state = {
        ...state,
        checksCache: {
          ...state.checksCache,
          [`unrelated-checks-${write}`]: { data: [], fetchedAt: write }
        }
      }
      wholeMapInvalidations += Number(previous.checksCache !== state.checksCache)
      const next = select(state)
      scopedInvalidations += Number(projection !== next)
      projection = next
    }

    expect(wholeMapInvalidations).toBe(600)
    expect(scopedInvalidations).toBe(0)
    expect(buildProjection).toHaveBeenCalledTimes(1)
  })

  it('rebuilds when a previously missing relevant entry appears', () => {
    const activeRepo = repo()
    const activeWorktree = worktree(0)
    const buildProjection = vi.fn(buildParentPrChecksProjection)
    const select = createParentPrChecksProjectionSelector(
      {
        worktrees: [activeWorktree],
        repos: [activeRepo],
        settings: null,
        refreshOutcomes: new Map()
      },
      buildProjection
    )
    const initialState = { hostedReviewCache: {}, prCache: {}, checksCache: {} }
    const initial = select(initialState)
    const relevantKey = getHostedReviewCacheKey(
      activeRepo.path,
      'feature-0',
      null,
      activeRepo.id,
      activeRepo.connectionId,
      activeRepo.executionHostId,
      true
    )
    const reviewEntry = { data: review(7), fetchedAt: 1, linkedReviewHintKey: '' }
    const relevantState = {
      ...initialState,
      hostedReviewCache: { [relevantKey]: reviewEntry }
    }
    const updated = select(relevantState)

    expect(updated).not.toBe(initial)
    expect(updated.rows[0]?.reviewLabel).toBe('#7')
    expect(buildProjection).toHaveBeenCalledTimes(2)

    const unrelatedState = {
      ...relevantState,
      checksCache: { unrelated: { data: [], fetchedAt: 2 } }
    }
    expect(select(unrelatedState)).toBe(updated)
    expect(buildProjection).toHaveBeenCalledTimes(2)
  })
})
