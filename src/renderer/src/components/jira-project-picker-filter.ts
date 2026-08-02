import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import type { JiraProject } from '../../../shared/types'

export const JIRA_PROJECT_PICKER_QUERY_MAX_BYTES = 2 * 1024

export function isJiraProjectPickerQueryTooLarge(
  query: string,
  maxBytes = JIRA_PROJECT_PICKER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function getJiraProjectPickerDisplayLabel(
  project: JiraProject,
  includeSiteName: boolean
): string {
  const projectLabel = `${project.name} (${project.key})`
  if (includeSiteName && project.siteName) {
    return `${project.siteName} · ${projectLabel}`
  }
  return projectLabel
}

function getJiraProjectPickerSearchText(project: JiraProject, includeSiteName: boolean): string {
  return [
    getJiraProjectPickerDisplayLabel(project, includeSiteName),
    project.key,
    project.name,
    project.siteName ?? ''
  ]
    .join(' ')
    .toLocaleLowerCase()
}

export function filterJiraProjectPickerProjects({
  projects,
  query,
  includeSiteName
}: {
  projects: readonly JiraProject[]
  query: string
  includeSiteName: boolean
}): JiraProject[] {
  if (isJiraProjectPickerQueryTooLarge(query)) {
    return []
  }
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return [...projects]
  }
  const normalizedQuery = trimmedQuery.toLocaleLowerCase()
  return projects.filter((project) =>
    getJiraProjectPickerSearchText(project, includeSiteName).includes(normalizedQuery)
  )
}
