// Shared catalogs keep the renderer, resume state, and RPC schema aligned.

import {
  boundLinearIssueAttributeFilter,
  canonicalizeLinearIssueAttributeFilter,
  emptyLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter,
  linearIssueAttributeFilterSignature,
  parseLinearIssueAttributeFilter,
  LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH,
  type LinearIssueAttributeFilter
} from './linear-issue-attribute-filter'

export const LINEAR_VIEW_MODES = ['list', 'board'] as const
export const LINEAR_GROUP_BY_OPTIONS = ['none', 'status', 'assignee', 'priority', 'team'] as const
export const LINEAR_ORDER_BY_OPTIONS = ['priority', 'updated', 'identifier'] as const
export const LINEAR_DISPLAY_PROPERTIES = [
  'state',
  'priority',
  'assignee',
  'team',
  'labels',
  'updated'
] as const

export type LinearViewMode = (typeof LINEAR_VIEW_MODES)[number]
export type LinearGroupBy = (typeof LINEAR_GROUP_BY_OPTIONS)[number]
export type LinearOrderBy = (typeof LINEAR_ORDER_BY_OPTIONS)[number]
export type LinearDisplayProperty = (typeof LINEAR_DISPLAY_PROPERTIES)[number]

export const DEFAULT_LINEAR_VIEW_MODE: LinearViewMode = 'list'
export const DEFAULT_LINEAR_GROUP_BY: LinearGroupBy = 'none'
export const DEFAULT_LINEAR_ORDER_BY: LinearOrderBy = 'priority'

export type LinearIssueViewResumeState = {
  viewMode: LinearViewMode
  groupBy: LinearGroupBy
  orderBy: LinearOrderBy
  displayProperties: LinearDisplayProperty[]
  teamPropertyTouched: boolean
  filtersByWorkspaceId: Record<string, LinearIssueAttributeFilter>
}

export type LinearIssueViewSelection = Omit<LinearIssueViewResumeState, 'displayProperties'> & {
  displayProperties: Iterable<LinearDisplayProperty>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMember<T extends string>(catalog: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (catalog as readonly string[]).includes(value)
}

export function defaultLinearIssueViewResumeState(): LinearIssueViewResumeState {
  return {
    viewMode: DEFAULT_LINEAR_VIEW_MODE,
    groupBy: DEFAULT_LINEAR_GROUP_BY,
    orderBy: DEFAULT_LINEAR_ORDER_BY,
    displayProperties: [...LINEAR_DISPLAY_PROPERTIES],
    teamPropertyTouched: false,
    filtersByWorkspaceId: {}
  }
}

function isSafeWorkspaceKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH &&
    key !== '__proto__'
  )
}

function normalizeFiltersByWorkspaceId(value: unknown): Record<string, LinearIssueAttributeFilter> {
  if (!isPlainObject(value)) {
    return {}
  }
  const next: Record<string, LinearIssueAttributeFilter> = {}
  for (const [workspaceId, filter] of Object.entries(value)) {
    if (!isSafeWorkspaceKey(workspaceId)) {
      continue
    }
    let parsed: LinearIssueAttributeFilter
    try {
      parsed = parseLinearIssueAttributeFilter(filter)
    } catch {
      continue
    }
    if (isEmptyLinearIssueAttributeFilter(parsed)) {
      continue
    }
    next[workspaceId] = parsed
  }
  return next
}

export function normalizeLinearIssueViewResumeState(
  value: unknown
): LinearIssueViewResumeState | undefined {
  if (!isPlainObject(value)) {
    return undefined
  }
  const next = defaultLinearIssueViewResumeState()
  if (isMember(LINEAR_VIEW_MODES, value.viewMode)) {
    next.viewMode = value.viewMode
  }
  if (isMember(LINEAR_GROUP_BY_OPTIONS, value.groupBy)) {
    next.groupBy = value.groupBy
  }
  if (isMember(LINEAR_ORDER_BY_OPTIONS, value.orderBy)) {
    next.orderBy = value.orderBy
  }
  const displayProperties: unknown = value.displayProperties
  if (Array.isArray(displayProperties)) {
    next.displayProperties = LINEAR_DISPLAY_PROPERTIES.filter((property) =>
      displayProperties.includes(property)
    )
  }
  if (typeof value.teamPropertyTouched === 'boolean') {
    next.teamPropertyTouched = value.teamPropertyTouched
  }
  next.filtersByWorkspaceId = normalizeFiltersByWorkspaceId(value.filtersByWorkspaceId)
  return isDefaultLinearIssueViewResumeState(next) ? undefined : next
}

export function resolveLinearIssueViewResumeState(value: unknown): LinearIssueViewResumeState {
  return normalizeLinearIssueViewResumeState(value) ?? defaultLinearIssueViewResumeState()
}

export function isDefaultLinearIssueViewResumeState(view: LinearIssueViewResumeState): boolean {
  return (
    view.viewMode === DEFAULT_LINEAR_VIEW_MODE &&
    view.groupBy === DEFAULT_LINEAR_GROUP_BY &&
    view.orderBy === DEFAULT_LINEAR_ORDER_BY &&
    view.teamPropertyTouched === false &&
    view.displayProperties.length === LINEAR_DISPLAY_PROPERTIES.length &&
    Object.keys(view.filtersByWorkspaceId).length === 0
  )
}

export function serializeLinearIssueViewResumeState(
  view: LinearIssueViewSelection
): LinearIssueViewResumeState {
  const filtersByWorkspaceId: Record<string, LinearIssueAttributeFilter> = {}
  for (const [workspaceId, filter] of Object.entries(view.filtersByWorkspaceId)) {
    if (!isSafeWorkspaceKey(workspaceId) || isEmptyLinearIssueAttributeFilter(filter)) {
      continue
    }
    const bounded = boundLinearIssueAttributeFilter(canonicalizeLinearIssueAttributeFilter(filter))
    if (isEmptyLinearIssueAttributeFilter(bounded)) {
      continue
    }
    filtersByWorkspaceId[workspaceId] = bounded
  }
  const selectedDisplayProperties = new Set(view.displayProperties)
  return {
    viewMode: view.viewMode,
    groupBy: view.groupBy,
    orderBy: view.orderBy,
    displayProperties: LINEAR_DISPLAY_PROPERTIES.filter((property) =>
      selectedDisplayProperties.has(property)
    ),
    teamPropertyTouched: view.teamPropertyTouched,
    filtersByWorkspaceId
  }
}

export function selectLinearWorkspaceIssueFilter(
  filters: Record<string, LinearIssueAttributeFilter>,
  workspaceId: string | null
): LinearIssueAttributeFilter {
  if (!workspaceId) {
    return emptyLinearIssueAttributeFilter()
  }
  const filter = Object.hasOwn(filters, workspaceId) ? filters[workspaceId] : undefined
  return filter ? canonicalizeLinearIssueAttributeFilter(filter) : emptyLinearIssueAttributeFilter()
}

export function setLinearWorkspaceIssueFilter(
  filters: Record<string, LinearIssueAttributeFilter>,
  workspaceId: string,
  filter: LinearIssueAttributeFilter
): Record<string, LinearIssueAttributeFilter> {
  if (!isSafeWorkspaceKey(workspaceId)) {
    return filters
  }
  const current = selectLinearWorkspaceIssueFilter(filters, workspaceId)
  if (
    linearIssueAttributeFilterSignature(current) === linearIssueAttributeFilterSignature(filter)
  ) {
    return filters
  }
  const next = { ...filters }
  delete next[workspaceId]
  if (isEmptyLinearIssueAttributeFilter(filter)) {
    return next
  }
  next[workspaceId] = canonicalizeLinearIssueAttributeFilter(filter)
  return next
}
