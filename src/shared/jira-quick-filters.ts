export const JIRA_STATUS_FILTER_RUNTIME_CAPABILITY = 'jira.issue-list-statuses.v1' as const
export const JIRA_STATUS_FILTER_UPDATE_REQUIRED = 'Update the Jira host to use status filters.'
export const MAX_JIRA_STATUS_FILTERS = 50
export const MAX_JIRA_STATUS_NAME_LENGTH = 128

export type JiraQuickFilterState = { statuses: string[] }

export function normalizeJiraStatusSelection(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [
    ...new Set(
      value.filter(
        (item): item is string =>
          typeof item === 'string' &&
          item.trim().length > 0 &&
          item.length <= MAX_JIRA_STATUS_NAME_LENGTH
      )
    )
  ].slice(0, MAX_JIRA_STATUS_FILTERS)
}

export function normalizeJiraQuickFilterState(value: unknown): JiraQuickFilterState {
  return {
    statuses: normalizeJiraStatusSelection(
      value && typeof value === 'object' && 'statuses' in value ? value.statuses : undefined
    )
  }
}
