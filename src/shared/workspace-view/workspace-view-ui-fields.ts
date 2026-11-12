import type { PersistedUIState } from '../persisted-ui-state-types'
import { WORKSPACE_ROW_FILTER_UI_FIELDS } from './workspace-row-filters'

/** The non-filter UI state a host's own phone mirrors through ui.get/ui.set. */
export const WORKSPACE_VIEW_UI_FIELDS = [
  'groupBy',
  'sortBy',
  'projectOrderBy',
  'worktreeCardProperties',
  'agentActivityDisplayMode',
  'collapsedGroups',
  'workspaceStatuses',
  // Keep the legacy scope for older readers and as fallback when no host list is saved.
  'workspaceHostScope'
] as const satisfies readonly (keyof PersistedUIState)[]

/** Every UI field behind the phone's Workspace options: the filters plus the fields above. */
export const ALL_WORKSPACE_VIEW_UI_FIELDS: readonly (keyof PersistedUIState)[] = [
  ...Object.values(WORKSPACE_ROW_FILTER_UI_FIELDS),
  ...WORKSPACE_VIEW_UI_FIELDS
]
