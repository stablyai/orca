import type { JiraProject } from '../../../shared/jira-types'

export function getJiraProjectSelectionKey(project: JiraProject): string {
  return `${project.siteId ?? 'selected'}:${project.id}`
}

const jiraProjectLabelCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

export function compareJiraProjectsByDisplayLabel(
  a: JiraProject,
  b: JiraProject,
  includeSiteName: boolean
): number {
  const siteComparison = includeSiteName
    ? jiraProjectLabelCollator.compare(a.siteName ?? '', b.siteName ?? '')
    : 0
  if (siteComparison !== 0) {
    return siteComparison
  }
  const nameComparison = jiraProjectLabelCollator.compare(a.name, b.name)
  if (nameComparison !== 0) {
    return nameComparison
  }
  return jiraProjectLabelCollator.compare(a.key, b.key)
}
