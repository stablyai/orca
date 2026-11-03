import { describe, expect, it } from 'vitest'
import { DAY, FACET_NOW, makeNamedFacets } from './workspace-cleanup-facet.test.fixture'
import { sortWorkspaceCleanupFacets } from './workspace-cleanup-facet-sort'
import type { WorkspaceCleanupSortField } from '../../../../shared/workspace-cleanup-filter-model'

function names(
  rows: ReturnType<typeof makeNamedFacets>[],
  field: WorkspaceCleanupSortField,
  direction: 'asc' | 'desc'
): string[] {
  return sortWorkspaceCleanupFacets(rows, { field, direction }).map((row) => row.displayName)
}

describe('absent values', () => {
  it('sinks unsized workspaces to the bottom in both directions', () => {
    const rows = [
      makeNamedFacets('unsized'),
      makeNamedFacets('small', { sizeBytes: 10 }),
      makeNamedFacets('big', { sizeBytes: 900 })
    ]
    expect(names(rows, 'size', 'desc')).toEqual(['big', 'small', 'unsized'])
    expect(names(rows, 'size', 'asc')).toEqual(['small', 'big', 'unsized'])
  })

  it('sinks never-visited workspaces to the bottom in both directions', () => {
    const rows = [
      makeNamedFacets('never'),
      makeNamedFacets('old', { lastVisitedAt: FACET_NOW - 50 * DAY }),
      makeNamedFacets('recent', { lastVisitedAt: FACET_NOW })
    ]
    expect(names(rows, 'last-visited', 'asc')).toEqual(['old', 'recent', 'never'])
    expect(names(rows, 'last-visited', 'desc')).toEqual(['recent', 'old', 'never'])
  })

  it('sinks review-less and ticket-less workspaces to the bottom', () => {
    const rows = [
      makeNamedFacets('none'),
      makeNamedFacets('merged', { review: { state: 'merged' } }),
      makeNamedFacets('open', { review: { state: 'open' } })
    ]
    expect(names(rows, 'review', 'desc')).toEqual(['open', 'merged', 'none'])

    const ticketRows = [
      makeNamedFacets('untracked'),
      makeNamedFacets('linear', { worktree: { linkedLinearIssue: 'STA-1' } })
    ]
    expect(names(ticketRows, 'ticket', 'asc')).toEqual(['linear', 'untracked'])
  })
})

describe('ranked fields', () => {
  it('orders git states from safest to riskiest', () => {
    const rows = [
      makeNamedFacets('unpushed', {
        candidate: {
          git: {
            clean: true,
            upstreamAhead: 2,
            upstreamBehind: 0,
            checkedAt: 1
          }
        }
      }),
      makeNamedFacets('clean'),
      makeNamedFacets('dirty', {
        candidate: {
          git: {
            clean: false,
            upstreamAhead: 0,
            upstreamBehind: 0,
            checkedAt: 1
          }
        }
      }),
      makeNamedFacets('unknown', {
        candidate: {
          git: {
            clean: null,
            upstreamAhead: 0,
            upstreamBehind: 0,
            checkedAt: null
          }
        }
      })
    ]
    expect(names(rows, 'git', 'asc')).toEqual(['clean', 'unknown', 'dirty', 'unpushed'])
  })

  it('orders agents idle to permission', () => {
    const agentRows = [
      makeNamedFacets('permission', { agentStatus: 'permission' }),
      makeNamedFacets('idle'),
      makeNamedFacets('working', { agentStatus: 'working' })
    ]
    expect(names(agentRows, 'agent', 'desc')).toEqual(['permission', 'working', 'idle'])
  })

  it('breaks equal blocker counts by the worst blocker', () => {
    const rows = [
      makeNamedFacets('softest', {
        candidate: { blockers: ['git-status-error'] }
      }),
      makeNamedFacets('hardest', {
        candidate: { blockers: ['main-worktree'] }
      })
    ]
    expect(names(rows, 'blocker-count', 'desc')).toEqual(['hardest', 'softest'])
  })
})

describe('tie-breaks', () => {
  it('falls back to activity, repo, name, then worktree id', () => {
    const rows = [
      makeNamedFacets('zeta', {
        candidate: { lastActivityAt: FACET_NOW - DAY }
      }),
      makeNamedFacets('alpha', {
        candidate: { lastActivityAt: FACET_NOW - 2 * DAY }
      })
    ]
    expect(names(rows, 'size', 'desc')).toEqual(['alpha', 'zeta'])
  })
})
