import {
  isEmptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../shared/linear-issue-attribute-filter'

export type LinearIssueEmptyKind =
  | 'context'
  | 'search'
  | 'server-attribute-filter'
  | 'client-team'
  | 'unfiltered-scope'
  | null

export function resolveLinearIssueEmptyKind(options: {
  hasContextLabel: boolean
  searchActive: boolean
  attributeFilter: LinearIssueAttributeFilter
  serverIssueCount: number
  filteredIssueCount: number
}): LinearIssueEmptyKind {
  if (options.serverIssueCount > 0 && options.filteredIssueCount === 0) {
    return 'client-team'
  }
  if (options.serverIssueCount > 0) {
    return null
  }
  if (options.hasContextLabel) {
    return 'context'
  }
  if (options.searchActive) {
    return 'search'
  }
  if (!isEmptyLinearIssueAttributeFilter(options.attributeFilter)) {
    return 'server-attribute-filter'
  }
  return 'unfiltered-scope'
}

export function shouldOfferLinearIssueFetchMore(options: {
  emptyKind: LinearIssueEmptyKind
  serverHasMore: boolean
}): boolean {
  // Why: Fetch more is only honest for client-team thinning of a larger server
  // window. Server-filtered empties must not invite more pages of the same empty set.
  return options.emptyKind === 'client-team' && options.serverHasMore
}
