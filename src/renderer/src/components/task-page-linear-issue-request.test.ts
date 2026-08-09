import { describe, expect, it } from 'vitest'
import {
  buildLinearIssueListReadArgs,
  buildLinearIssueListRequestSignature,
  isLinearIssueSearchActive,
  shouldClearTeamDerivedFacets,
  shouldForceLinearIssueListRead,
  teamDerivedFacetsForPrimaryTeamChange
} from './task-page-linear-issue-request'
import type { LinearIssueAttributeFilter } from '../../../shared/linear-issue-attribute-filter'

const filter: LinearIssueAttributeFilter = {
  stateIds: ['s1'],
  priorities: [1],
  assignee: { kind: 'unassigned' },
  labelIds: ['l1']
}

describe('task-page-linear-issue-request', () => {
  it('treats immediate or applied search as active', () => {
    expect(isLinearIssueSearchActive('q', '')).toBe(true)
    expect(isLinearIssueSearchActive('', 'q')).toBe(true)
    expect(isLinearIssueSearchActive('  ', '  ')).toBe(false)
  })

  it('omits attribute filters from list read args while search is active', () => {
    expect(
      buildLinearIssueListReadArgs({
        limit: 36,
        attributeFilter: filter,
        searchActive: true
      }).attributeFilter
    ).toBeUndefined()
    expect(
      buildLinearIssueListReadArgs({
        limit: 36,
        attributeFilter: filter,
        searchActive: false
      }).attributeFilter
    ).toEqual(filter)
  })

  it('includes source scope and canonical signature in the request identity', () => {
    const signature = buildLinearIssueListRequestSignature({
      workspaceId: 'ws-1',
      limit: 36,
      attributeFilter: filter
    })
    expect(signature).toContain('local::ws-1::list::all::36::')
    expect(signature).toContain('"stateIds":["s1"]')
  })

  it('forces a read when the filter signature changes within one workspace', () => {
    expect(
      shouldForceLinearIssueListRead({
        previousFilterRead: { workspaceId: 'ws-1', signature: 'a' },
        nextFilterRead: { workspaceId: 'ws-1', signature: 'b' },
        refreshForced: false
      })
    ).toBe(true)
    expect(
      shouldForceLinearIssueListRead({
        previousFilterRead: { workspaceId: 'ws-1', signature: 'a' },
        nextFilterRead: { workspaceId: 'ws-1', signature: 'a' },
        refreshForced: false
      })
    ).toBe(false)
  })

  it('does not force the first read of a session, so a restored filter serves warm cache', () => {
    expect(
      shouldForceLinearIssueListRead({
        previousFilterRead: null,
        nextFilterRead: { workspaceId: 'ws-1', signature: 'restored' },
        refreshForced: false
      })
    ).toBe(false)
    expect(
      shouldForceLinearIssueListRead({
        previousFilterRead: null,
        nextFilterRead: { workspaceId: 'ws-1', signature: 'restored' },
        refreshForced: true
      })
    ).toBe(true)
  })

  // Why: the list cache is workspace-keyed, so B's warm entry is already correct —
  // forcing would mean a round trip behind a blocking spinner on every switch.
  it('does not force on a workspace switch, even when each workspace has its own filter', () => {
    expect(
      shouldForceLinearIssueListRead({
        previousFilterRead: { workspaceId: 'ws-1', signature: 'filter-a' },
        nextFilterRead: { workspaceId: 'ws-2', signature: 'filter-b' },
        refreshForced: false
      })
    ).toBe(false)
  })

  it('clears team-derived facets only when the primary team changes within one workspace', () => {
    expect(
      shouldClearTeamDerivedFacets({
        previous: { workspaceId: 'ws-1', teamId: 'team-a' },
        next: { workspaceId: 'ws-1', teamId: 'team-b' }
      })
    ).toBe(true)
    // Why: a workspace switch swaps in that workspace's own persisted filter.
    expect(
      shouldClearTeamDerivedFacets({
        previous: { workspaceId: 'ws-1', teamId: 'team-a' },
        next: { workspaceId: 'ws-2', teamId: 'team-b' }
      })
    ).toBe(false)
    expect(
      shouldClearTeamDerivedFacets({
        previous: null,
        next: { workspaceId: 'ws-1', teamId: 'team-a' }
      })
    ).toBe(false)
    expect(
      shouldClearTeamDerivedFacets({
        previous: { workspaceId: 'ws-1', teamId: 'team-a' },
        next: { workspaceId: 'ws-1', teamId: 'team-a' }
      })
    ).toBe(false)
  })

  it('clears team-derived facets while preserving priority', () => {
    expect(teamDerivedFacetsForPrimaryTeamChange(filter)).toEqual({
      stateIds: [],
      priorities: [1],
      assignee: null,
      labelIds: []
    })
  })
})
