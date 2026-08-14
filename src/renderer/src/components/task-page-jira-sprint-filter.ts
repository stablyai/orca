import type { JiraPresetId } from './task-page-localized-options'

// Why: mirrors filterToJql in src/main/jira/issues.ts — composing the sprint
// clause client-side rides the existing JQL search path, so it works against
// remote runtimes that predate this filter without any wire change.
const PRESET_JQL: Record<JiraPresetId, string> = {
  assigned: 'assignee = currentUser() AND resolution = Unresolved',
  reported: 'reporter = currentUser() AND resolution = Unresolved',
  done: 'assignee = currentUser() AND resolution IS NOT EMPTY',
  all: 'resolution = Unresolved'
}
const PRESET_ORDER_BY = 'ORDER BY updated DESC'
const CURRENT_SPRINT_CLAUSE = 'sprint in openSprints()'

export function jiraCurrentSprintJql(preset: JiraPresetId, appliedSearch: string): string {
  const trimmed = appliedSearch.trim()
  if (trimmed.length > 0) {
    return withCurrentSprintClause(trimmed)
  }
  return `${PRESET_JQL[preset]} AND ${CURRENT_SPRINT_CLAUSE} ${PRESET_ORDER_BY}`
}

export function withCurrentSprintClause(jql: string): string {
  const orderByMatch = jql.match(/\sORDER\s+BY\s[\s\S]*$/i)
  if (!orderByMatch || orderByMatch.index === undefined) {
    return `(${jql}) AND ${CURRENT_SPRINT_CLAUSE}`
  }
  const where = jql.slice(0, orderByMatch.index).trim()
  if (!where) {
    return jql
  }
  const orderBy = jql.slice(orderByMatch.index).trim()
  return `(${where}) AND ${CURRENT_SPRINT_CLAUSE} ${orderBy}`
}
