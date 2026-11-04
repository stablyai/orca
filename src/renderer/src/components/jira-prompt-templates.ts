import type { JiraIssue } from '../../../shared/jira/jira-types'
import { translate } from '@/i18n/i18n'

export function buildJiraIssuePrompt(issue: JiraIssue): string {
  return `Complete Jira issue ${issue.key}: ${issue.title}\n\n${issue.url}${issue.description?.trim() ? `\n\n${issue.description.trim()}` : ''}`
}

export function getJiraPromptTemplates() {
  return [
    {
      id: 'implementation',
      label: translate('jira.prompt.implementation', 'Start implementation'),
      text: 'Implement the following Jira issue. Inspect the existing code, make the changes, and verify them.\n\n$jira-issue\n\n$other-prompt'
    },
    {
      id: 'bug',
      label: translate('jira.prompt.bug', 'Investigate bug'),
      text: 'Investigate this Jira issue. Reproduce the problem, explain the cause, and propose a fix supported by evidence.\n\n$jira-issue\n\n$other-prompt'
    },
    {
      id: 'test-plan',
      label: translate('jira.prompt.testPlan', 'Write test plan'),
      text: 'Write a test plan for this Jira issue, covering normal behavior, edge cases, and regressions.\n\n$jira-issue\n\n$other-prompt'
    },
    {
      id: 'pr-summary',
      label: translate('jira.prompt.prSummary', 'Draft PR summary'),
      text: 'Draft a pull request summary for this Jira issue. Describe the problem, changes, validation, and remaining risks. Do not claim unverified work is complete.\n\n$jira-issue\n\n$other-prompt'
    }
  ]
}

export function renderJiraPromptTemplate(
  template: string,
  issue: JiraIssue,
  otherPrompt: string
): string {
  return template
    .replace(/\$(jira-issue|other-prompt)\b/g, (_, variable: string) =>
      variable === 'jira-issue' ? buildJiraIssuePrompt(issue) : otherPrompt.trim()
    )
    .trim()
}

const CUSTOM_TEMPLATE_KEY = 'orca.jira.copy-prompt-template.v1'
export function loadCustomJiraPromptTemplate(): string {
  try {
    return localStorage.getItem(CUSTOM_TEMPLATE_KEY) ?? '$jira-issue\n\n$other-prompt'
  } catch {
    return '$jira-issue\n\n$other-prompt'
  }
}
export function saveCustomJiraPromptTemplate(template: string): void {
  try {
    localStorage.setItem(CUSTOM_TEMPLATE_KEY, template)
  } catch {
    // Copying remains available when device storage is full.
  }
}
