import { describe, expect, it } from 'vitest'
import {
  resolveLinearIssueEmptyKind,
  shouldOfferLinearIssueFetchMore
} from './task-page-linear-issue-empty-state'
import { emptyLinearIssueAttributeFilter } from '../../../shared/linear-issue-attribute-filter'

describe('task-page-linear-issue-empty-state', () => {
  it('prefers context, then search, then server filter, then client team, then unfiltered', () => {
    expect(
      resolveLinearIssueEmptyKind({
        hasContextLabel: true,
        searchActive: true,
        attributeFilter: emptyLinearIssueAttributeFilter(),
        serverIssueCount: 0,
        filteredIssueCount: 0
      })
    ).toBe('context')

    expect(
      resolveLinearIssueEmptyKind({
        hasContextLabel: false,
        searchActive: true,
        attributeFilter: {
          stateIds: ['s'],
          priorities: [],
          assignee: null,
          labelIds: []
        },
        serverIssueCount: 0,
        filteredIssueCount: 0
      })
    ).toBe('search')

    expect(
      resolveLinearIssueEmptyKind({
        hasContextLabel: false,
        searchActive: false,
        attributeFilter: {
          stateIds: ['s'],
          priorities: [],
          assignee: null,
          labelIds: []
        },
        serverIssueCount: 0,
        filteredIssueCount: 0
      })
    ).toBe('server-attribute-filter')

    expect(
      resolveLinearIssueEmptyKind({
        hasContextLabel: false,
        searchActive: false,
        attributeFilter: emptyLinearIssueAttributeFilter(),
        serverIssueCount: 3,
        filteredIssueCount: 0
      })
    ).toBe('client-team')

    expect(
      resolveLinearIssueEmptyKind({
        hasContextLabel: false,
        searchActive: false,
        attributeFilter: emptyLinearIssueAttributeFilter(),
        serverIssueCount: 0,
        filteredIssueCount: 0
      })
    ).toBe('unfiltered-scope')
  })

  it('offers fetch more only for client-team thinning with server hasMore', () => {
    expect(shouldOfferLinearIssueFetchMore({ emptyKind: 'client-team', serverHasMore: true })).toBe(
      true
    )
    expect(
      shouldOfferLinearIssueFetchMore({
        emptyKind: 'server-attribute-filter',
        serverHasMore: true
      })
    ).toBe(false)
  })
})
