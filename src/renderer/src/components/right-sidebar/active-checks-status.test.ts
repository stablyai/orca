import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACTIVE_CHECKS_STATUS_INPUT_KEYS,
  clearActiveChecksStatusCacheForTests,
  getActiveChecksStatus
} from './active-checks-status'
import type { AppState } from '../../store/types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'

function makePR(status: PRInfo['checksStatus']): PRInfo {
  return {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/12',
    checksStatus: status,
    updatedAt: '2026-05-20T00:00:00Z',
    mergeable: 'MERGEABLE'
  }
}

describe('getActiveChecksStatus', () => {
  beforeEach(() => {
    clearActiveChecksStatusCacheForTests()
  })

  it('prefers repo-id scoped status over stale path-scoped status for the active worktree', () => {
    const state = {
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            branch: 'refs/heads/feature/test'
          }
        ]
      },
      prCache: {
        'repo-1::feature/test': { data: makePR('success'), fetchedAt: 2 },
        '/repo::feature/test': { data: makePR('failure'), fetchedAt: 999 }
      }
    } as unknown as Pick<AppState, 'activeWorktreeId' | 'repos' | 'worktreesByRepo' | 'prCache'>

    expect(getActiveChecksStatus(state)).toBe('success')
  })

  it('uses GitLab MR pipeline status when the active branch has no GitHub PR cache entry', () => {
    const state = {
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            branch: 'refs/heads/feature/gitlab',
            linkedGitLabMR: 7
          }
        ]
      },
      prCache: {},
      hostedReviewCache: {
        'local::repo-1::feature/gitlab': {
          data: {
            provider: 'gitlab',
            number: 7,
            title: 'GitLab MR',
            state: 'open',
            url: 'https://gitlab.com/acme/orca/-/merge_requests/7',
            status: 'success',
            updatedAt: '2026-05-20T00:00:00Z',
            mergeable: 'MERGEABLE'
          },
          fetchedAt: 2
        }
      }
    } as unknown as Pick<
      AppState,
      'activeWorktreeId' | 'repos' | 'worktreesByRepo' | 'prCache' | 'hostedReviewCache'
    >

    expect(getActiveChecksStatus(state)).toBe('success')
  })

  it('does not show stale GitHub PR status for a linked GitLab MR while MR status is loading', () => {
    const state = {
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            branch: 'refs/heads/feature/gitlab',
            linkedGitLabMR: 7
          }
        ]
      },
      prCache: {
        'repo-1::feature/gitlab': { data: makePR('failure'), fetchedAt: 2 }
      },
      hostedReviewCache: {}
    } as unknown as Pick<
      AppState,
      'activeWorktreeId' | 'repos' | 'worktreesByRepo' | 'prCache' | 'hostedReviewCache'
    >

    expect(getActiveChecksStatus(state)).toBeNull()
  })

  it('hides the matching suppressed GitHub PR status', () => {
    const state = {
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            branch: 'refs/heads/feature/test',
            linkedPR: null,
            suppressedGitHubPR: 12
          }
        ]
      },
      prCache: {
        'repo-1::feature/test': { data: makePR('failure'), fetchedAt: 2 }
      }
    } as unknown as Pick<AppState, 'activeWorktreeId' | 'repos' | 'worktreesByRepo' | 'prCache'>

    expect(getActiveChecksStatus(state)).toBeNull()
  })
})

describe('getActiveChecksStatus caching', () => {
  beforeEach(() => {
    clearActiveChecksStatusCacheForTests()
  })

  function makeState(prCache: Record<string, unknown>) {
    return {
      activeWorktreeId: 'wt-1',
      repos: [{ id: 'repo-1', path: '/repo' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', branch: 'refs/heads/feature/test' }]
      },
      prCache
    } as unknown as Pick<AppState, 'activeWorktreeId' | 'repos' | 'worktreesByRepo' | 'prCache'>
  }

  it('reuses the cached status when every input reference is unchanged', () => {
    const prCache = { 'repo-1::feature/test': { data: makePR('success'), fetchedAt: 2 } }
    const state = makeState(prCache)

    expect(getActiveChecksStatus(state)).toBe('success')
    // A different state object carrying the same field references must still hit the cache.
    expect(getActiveChecksStatus({ ...state })).toBe('success')
  })

  it('recomputes when a keyed input reference changes', () => {
    expect(
      getActiveChecksStatus(
        makeState({ 'repo-1::feature/test': { data: makePR('success'), fetchedAt: 2 } })
      )
    ).toBe('success')
    expect(
      getActiveChecksStatus(
        makeState({ 'repo-1::feature/test': { data: makePR('failure'), fetchedAt: 3 } })
      )
    ).toBe('failure')
  })

  it('reads no store field the cache is not keyed on', () => {
    // Guards against a cast or widened type bypassing the derived key list: every property the
    // computation touches on the state object must invalidate the cache.
    const reads = new Set<PropertyKey>()
    const keyed = new Set<PropertyKey>(ACTIVE_CHECKS_STATUS_INPUT_KEYS)
    const state = new Proxy(
      makeState({ 'repo-1::feature/test': { data: makePR('success'), fetchedAt: 2 } }),
      {
        get(target, prop, receiver) {
          reads.add(prop)
          return Reflect.get(target, prop, receiver)
        },
        has(target, prop) {
          reads.add(prop)
          return Reflect.has(target, prop)
        }
      }
    )

    expect(getActiveChecksStatus(state)).toBe('success')
    expect([...reads].filter((prop) => !keyed.has(prop))).toEqual([])
    // The read set must also be non-trivial, or the guard proves nothing.
    expect(reads.has('prCache')).toBe(true)
  })
})
