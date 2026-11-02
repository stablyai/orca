import type {
  AzureDevOpsBacklogSavedFilter,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'
import {
  EMPTY_BACKLOG_FILTERS,
  UNASSIGNED_FILTER_VALUE,
  type BacklogFilters
} from './task-page-azure-devops-backlog-filters'

// Why: ADO's own label for the no-assignee pill; it lands in the saved filter as a display name.
const ADO_UNASSIGNED_DISPLAY = 'Unassigned'

/**
 * Local filter state from the user's saved ADO filter. Assignees are stored as
 * display names, so they resolve to unique names through the items on the page;
 * a name with no match on the page is kept as-is and matched by display name.
 */
export function seedBacklogFiltersFromSaved(
  saved: AzureDevOpsBacklogSavedFilter,
  items: readonly AzureDevOpsWorkItem[]
): BacklogFilters {
  const uniqueByDisplay = new Map<string, string>()
  for (const item of items) {
    if (item.assignedTo?.uniqueName) {
      uniqueByDisplay.set(item.assignedTo.displayName, item.assignedTo.uniqueName)
    }
  }
  return {
    ...EMPTY_BACKLOG_FILTERS,
    keyword: saved.keyword ?? '',
    workItemTypes: new Set(saved.workItemTypes),
    assignedTo: new Set(
      saved.assignedTo.map((name) =>
        name === ADO_UNASSIGNED_DISPLAY
          ? UNASSIGNED_FILTER_VALUE
          : (uniqueByDisplay.get(name) ?? name)
      )
    ),
    states: new Set(saved.states),
    areaPaths: new Set(saved.areaPaths),
    iterationPath: saved.iterationPaths[0] ?? null,
    tags: new Set(saved.tags)
  }
}
