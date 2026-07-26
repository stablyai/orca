// Why: shared coercion between TaskResumeState (persisted, plain JSON) and the
// Linear issue list's in-memory view state, so restore defaults and the persisted
// payload can be tested without rendering TaskPage.

import {
  canonicalizeLinearIssueAttributeFilter,
  emptyLinearIssueAttributeFilter,
  isEmptyLinearIssueAttributeFilter,
  type LinearIssueAttributeFilter
} from '../../../shared/linear-issue-attribute-filter'
import type { TaskResumeState } from '../../../shared/types'
import type {
  LinearDisplayProperty,
  LinearGroupBy,
  LinearOrderBy,
  LinearViewMode
} from '@/components/task-page-localized-options'

export const DEFAULT_LINEAR_DISPLAY_PROPERTIES: LinearDisplayProperty[] = [
  'state',
  'priority',
  'assignee',
  'team',
  'labels',
  'updated'
]

export type LinearIssueViewPreferences = {
  viewMode: LinearViewMode
  groupBy: LinearGroupBy
  orderBy: LinearOrderBy
  displayProperties: ReadonlySet<LinearDisplayProperty>
  /** True once the user overrides the single-team auto-hide of the Team column. */
  teamPropertyTouched: boolean
  attributeFilter: LinearIssueAttributeFilter
}

export function resolveLinearIssueViewPreferences(
  resume: TaskResumeState | undefined
): LinearIssueViewPreferences {
  return {
    viewMode: resume?.linearViewMode ?? 'list',
    groupBy: resume?.linearGroupBy ?? 'none',
    orderBy: resume?.linearOrderBy ?? 'priority',
    displayProperties: new Set(
      resume?.linearDisplayProperties ?? DEFAULT_LINEAR_DISPLAY_PROPERTIES
    ),
    teamPropertyTouched: resume?.linearTeamPropertyTouched ?? false,
    attributeFilter: resume?.linearIssueFilter ?? emptyLinearIssueAttributeFilter()
  }
}

export function linearIssueViewPreferencesResumeUpdate(
  preferences: LinearIssueViewPreferences,
  workspaceId: string | null
): Partial<TaskResumeState> {
  const filtered = !isEmptyLinearIssueAttributeFilter(preferences.attributeFilter)
  return {
    linearViewMode: preferences.viewMode,
    linearGroupBy: preferences.groupBy,
    linearOrderBy: preferences.orderBy,
    // Why: emit in catalog order so toggling a property off and on doesn't rewrite the payload.
    linearDisplayProperties: DEFAULT_LINEAR_DISPLAY_PROPERTIES.filter((property) =>
      preferences.displayProperties.has(property)
    ),
    linearTeamPropertyTouched: preferences.teamPropertyTouched,
    linearIssueFilter: filtered
      ? canonicalizeLinearIssueAttributeFilter(preferences.attributeFilter)
      : undefined,
    linearIssueFilterWorkspaceId: filtered && workspaceId !== null ? workspaceId : undefined
  }
}

/**
 * Filter facets are workspace-scoped ids, so a real workspace switch has to drop them.
 * A null id means Linear status has not resolved yet (or disconnected), which is not a switch —
 * treating it as one would clear the filter restored from the previous session on every launch.
 */
export function shouldResetLinearFilterForWorkspaceChange(
  previousWorkspaceId: string | undefined,
  nextWorkspaceId: string | null
): boolean {
  return (
    nextWorkspaceId !== null &&
    previousWorkspaceId !== undefined &&
    previousWorkspaceId !== nextWorkspaceId
  )
}
