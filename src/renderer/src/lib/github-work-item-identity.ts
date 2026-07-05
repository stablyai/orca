import { parseGitHubIssueOrPRLink } from '@/lib/github-links'

export type GitHubWorkItemIdentity = {
  type: 'issue' | 'pr'
  number: number
}

export function resolveGitHubWorkItemIdentity(item: {
  type: 'issue' | 'pr'
  number: number
  url?: string | null
}): GitHubWorkItemIdentity {
  const link = item.url ? parseGitHubIssueOrPRLink(item.url) : null
  if (link) {
    // Why: stale cached work-item payloads can disagree with a pasted URL. The
    // URL path is the user-visible intent, so it decides issue-vs-PR launches.
    return { type: link.type, number: link.number }
  }
  return { type: item.type, number: item.number }
}
