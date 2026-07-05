import type { LinkedWorkItemSummary } from './new-workspace'

// Why: self-hosted GitLab issue URLs may not contain "gitlab", and modern
// GitLab emits issue URLs as `/-/work_items/<iid>` as well as the legacy
// `/-/issues/<iid>`. Recognize both forms.
const GL_ISSUE_PATH_RE = /\/-\/(?:issues|work_items)\//i

export function isGitLabIssueUrl(url: string): boolean {
  try {
    return GL_ISSUE_PATH_RE.test(new URL(url).pathname)
  } catch {
    return GL_ISSUE_PATH_RE.test(url)
  }
}

function isJiraIssueUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      /\.atlassian\.net$/i.test(parsed.hostname) ||
      /\/browse\/[A-Z][A-Z0-9]+-\d+/i.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

export function getLinkedWorkItemProvider(
  item: LinkedWorkItemSummary
): NonNullable<LinkedWorkItemSummary['provider']> {
  if (item.provider) {
    return item.provider
  }
  if (item.linearIdentifier) {
    return 'linear'
  }
  if (item.jiraIdentifier || isJiraIssueUrl(item.url)) {
    return 'jira'
  }
  if (item.type === 'mr') {
    return 'gitlab'
  }
  if (isGitLabIssueUrl(item.url)) {
    return 'gitlab'
  }
  if (item.number === 0 && !item.url.includes('github.com')) {
    return 'linear'
  }
  return 'github'
}
