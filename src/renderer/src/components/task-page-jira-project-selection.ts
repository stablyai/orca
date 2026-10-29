import type { JiraProject } from '../../../shared/jira/jira-types'
import { uiCollator } from '@/i18n/ui-intl-formatters'

export function getJiraProjectSelectionKey(project: JiraProject): string {
  return `${project.siteId ?? 'selected'}:${project.id}`
}

const JIRA_PROJECT_LABEL_OPTIONS: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: 'base'
}

export function compareJiraProjectsByDisplayLabel(
  a: JiraProject,
  b: JiraProject,
  includeSiteName: boolean
): number {
  const siteComparison = includeSiteName
    ? uiCollator(JIRA_PROJECT_LABEL_OPTIONS).compare(a.siteName ?? '', b.siteName ?? '')
    : 0
  if (siteComparison !== 0) {
    return siteComparison
  }
  const nameComparison = uiCollator(JIRA_PROJECT_LABEL_OPTIONS).compare(a.name, b.name)
  if (nameComparison !== 0) {
    return nameComparison
  }
  return uiCollator(JIRA_PROJECT_LABEL_OPTIONS).compare(a.key, b.key)
}
