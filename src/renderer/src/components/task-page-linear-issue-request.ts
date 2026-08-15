import {
  isEmptyLinearIssueAttributeFilter,
  linearIssueAttributeFilterSignature,
  type LinearIssueAttributeFilter
} from '../../../shared/linear/issue-attribute-filter'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { LinearIssueListReadArgs } from '../store/slices/linear'

export function isLinearIssueSearchActive(immediateQuery: string, appliedQuery: string): boolean {
  return immediateQuery.trim().length > 0 || appliedQuery.trim().length > 0
}

export function buildLinearIssueListReadArgs(options: {
  filter?: 'assigned' | 'created' | 'all' | 'completed'
  limit: number
  attributeFilter: LinearIssueAttributeFilter
  searchActive: boolean
  allowAttributeFilter?: boolean
}): LinearIssueListReadArgs {
  const attributeFilter =
    options.searchActive ||
    options.allowAttributeFilter === false ||
    isEmptyLinearIssueAttributeFilter(options.attributeFilter)
      ? undefined
      : options.attributeFilter
  return {
    kind: 'list',
    filter: options.filter ?? 'all',
    limit: options.limit,
    attributeFilter
  }
}

export function buildLinearIssueListRequestSignature(options: {
  sourceContext?: TaskSourceContext | null
  workspaceId: string | null | undefined
  filter?: 'assigned' | 'created' | 'all' | 'completed'
  limit: number
  attributeFilter: LinearIssueAttributeFilter
  searchQuery?: string
}): string {
  const sourceScope = options.sourceContext
    ? getTaskSourceCacheScope(options.sourceContext)
    : 'local'
  const workspace = options.workspaceId ?? 'default'
  if (options.searchQuery && options.searchQuery.trim().length > 0) {
    return `${sourceScope}::${workspace}::search::${options.searchQuery.trim()}`
  }
  const signature = linearIssueAttributeFilterSignature(options.attributeFilter)
  return `${sourceScope}::${workspace}::list::${options.filter ?? 'all'}::${options.limit}::${signature}`
}

export type LinearIssueListFilterRead = { workspaceId: string | null; signature: string }

export function shouldForceLinearIssueListRead(options: {
  previousFilterRead: LinearIssueListFilterRead | null
  nextFilterRead: LinearIssueListFilterRead
  refreshForced: boolean
}): boolean {
  if (options.refreshForced) {
    return true
  }
  if (options.previousFilterRead === null) {
    return false
  }
  if (options.previousFilterRead.workspaceId !== options.nextFilterRead.workspaceId) {
    return false
  }
  return options.previousFilterRead.signature !== options.nextFilterRead.signature
}

export type LinearPrimaryTeamObservation = { workspaceId: string | null; teamId: string }

export function shouldClearTeamDerivedFacets(options: {
  previous: LinearPrimaryTeamObservation | null
  next: LinearPrimaryTeamObservation
}): boolean {
  const { previous, next } = options
  if (!previous) {
    return false
  }
  return previous.workspaceId === next.workspaceId && previous.teamId !== next.teamId
}

export function teamDerivedFacetsForPrimaryTeamChange(
  current: LinearIssueAttributeFilter
): LinearIssueAttributeFilter {
  return {
    stateIds: [],
    priorities: current.priorities,
    assignee: null,
    labelIds: []
  }
}
