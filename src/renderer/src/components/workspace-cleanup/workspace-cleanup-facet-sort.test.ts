import { describe, expect, it } from 'vitest'
import { DAY, FACET_NOW, makeNamedFacets } from './workspace-cleanup-facet.test.fixture'
import {
  isWorkspaceCleanupAbsentLastSortField,
  sortWorkspaceCleanupFacets
} from './workspace-cleanup-facet-sort'
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

  it('marks exactly the optional-value fields as absent-last', () => {
    expect(isWorkspaceCleanupAbsentLastSortField('size')).toBe(true)
    expect(isWorkspaceCleanupAbsentLastSortField('name')).toBe(false)
  })
})

describe('ranked fields', () => {
  it('orders git states from safest to riskiest', () => {
    const rows = [
      makeNamedFacets('unpushed', {
        candidate: { git: { clean: true, upstreamAhead: 2, upstreamBehind: 0, checkedAt: 1 } }
      }),
      makeNamedFacets('clean'),
      makeNamedFacets('dirty', {
        candidate: { git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 } }
      }),
      makeNamedFacets('unknown', {
        candidate: { git: { clean: null, upstreamAhead: 0, upstreamBehind: 0, checkedAt: null } }
      })
    ]
    expect(names(rows, 'git', 'asc')).toEqual(['clean', 'unknown', 'dirty', 'unpushed'])
  })

  it('orders tiers ready to protected and agents idle to permission', () => {
    const tierRows = [
      makeNamedFacets('protectedRow', { candidate: { tier: 'protected' } }),
      makeNamedFacets('readyRow', { candidate: { tier: 'ready' } }),
      makeNamedFacets('reviewRow', { candidate: { tier: 'review' } })
    ]
    expect(names(tierRows, 'tier', 'asc')).toEqual(['readyRow', 'reviewRow', 'protectedRow'])

    const agentRows = [
      makeNamedFacets('permission', { agentStatus: 'permission' }),
      makeNamedFacets('idle'),
      makeNamedFacets('working', { agentStatus: 'working' })
    ]
    expect(names(agentRows, 'agent', 'desc')).toEqual(['permission', 'working', 'idle'])
  })

  it('breaks equal blocker counts by the worst blocker', () => {
    const rows = [
      makeNamedFacets('softest', { candidate: { blockers: ['git-status-error'] } }),
      makeNamedFacets('hardest', { candidate: { blockers: ['main-worktree'] } })
    ]
    expect(names(rows, 'blocker-count', 'desc')).toEqual(['hardest', 'softest'])
  })
})

describe('tie-breaks', () => {
  it('falls back to activity, repo, name, then worktree id', () => {
    const rows = [
      makeNamedFacets('zeta', { candidate: { lastActivityAt: FACET_NOW - DAY } }),
      makeNamedFacets('alpha', { candidate: { lastActivityAt: FACET_NOW - 2 * DAY } })
    ]
    // Same size on both sides, so only the tie-break chain can order them.
    expect(names(rows, 'size', 'desc')).toEqual(['alpha', 'zeta'])
  })

  it('keeps tie-broken rows in the same order when direction flips', () => {
    const rows = [
      makeNamedFacets('b', { candidate: { lastActivityAt: FACET_NOW - DAY } }),
      makeNamedFacets('a', { candidate: { lastActivityAt: FACET_NOW - 2 * DAY } })
    ]
    expect(names(rows, 'git', 'asc')).toEqual(names(rows, 'git', 'desc'))
  })

  it('does not mutate the input array', () => {
    const rows = [makeNamedFacets('b'), makeNamedFacets('a')]
    const before = rows.map((row) => row.displayName)
    sortWorkspaceCleanupFacets(rows, { field: 'name', direction: 'asc' })
    expect(rows.map((row) => row.displayName)).toEqual(before)
  })
})

describe('text fields', () => {
  it('sorts by name, repo, path, branch, and host', () => {
    const rows = [makeNamedFacets('charlie'), makeNamedFacets('alpha'), makeNamedFacets('bravo')]
    expect(names(rows, 'name', 'asc')).toEqual(['alpha', 'bravo', 'charlie'])
    expect(names(rows, 'path', 'desc')).toEqual(['charlie', 'bravo', 'alpha'])
    expect(names(rows, 'branch', 'asc')).toEqual(['alpha', 'bravo', 'charlie'])

    const hostRows = [
      makeNamedFacets('remote', { worktree: { hostId: 'ssh:builder' } }),
      makeNamedFacets('here', { worktree: { hostId: 'local' } })
    ]
    expect(names(hostRows, 'host', 'asc')).toEqual(['here', 'remote'])
  })
})
