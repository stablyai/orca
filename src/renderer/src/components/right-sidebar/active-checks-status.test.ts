import { describe, expect, it } from 'vitest'
import { getActiveChecksStatus } from './active-checks-status'
import type { AppState } from '../../store/types'
import type { PRInfo } from '../../../../shared/types'

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
})
