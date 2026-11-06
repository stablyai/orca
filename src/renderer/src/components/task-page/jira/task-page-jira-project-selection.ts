import type { JiraProject } from '../../../../../shared/jira/jira-types'
import { uiCollator } from '@/i18n/ui-intl-formatters'

export function getJiraProjectSelectionKey(project: JiraProject): string {
  return `${project.siteId ?? 'selected'}:${project.id}`
}

const JIRA_PROJECT_LABEL_OPTIONS: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: 'base'
}

// Why: resolve the UI-language collator once per sort, not on every comparison.
export function jiraProjectDisplayLabelComparator(
  includeSiteName: boolean
): (a: JiraProject, b: JiraProject) => number {
  const collator = uiCollator(JIRA_PROJECT_LABEL_OPTIONS)
  return (a, b) => {
    const siteComparison = includeSiteName
      ? collator.compare(a.siteName ?? '', b.siteName ?? '')
      : 0
    if (siteComparison !== 0) {
      return siteComparison
    }
    const nameComparison = collator.compare(a.name, b.name)
    if (nameComparison !== 0) {
      return nameComparison
    }
    return collator.compare(a.key, b.key)
  }
}
