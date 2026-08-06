import { describe, expect, it } from 'vitest'
import {
  buildLinearIssueListReadArgs,
  buildLinearIssueListRequestSignature,
  isLinearIssueSearchActive,
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

  it('forces a read when the filter signature changes', () => {
    expect(
      shouldForceLinearIssueListRead({
        previousFilterSignature: 'a',
        nextFilterSignature: 'b',
        refreshForced: false
      })
    ).toBe(true)
    expect(
      shouldForceLinearIssueListRead({
        previousFilterSignature: 'a',
        nextFilterSignature: 'a',
        refreshForced: false
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
