import { parseGitHubIssueOrPRLink } from './github-links'

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
    // Pasted URL paths express user intent and override stale cached issue/PR classification.
    return { type: link.type, number: link.number }
  }
  return { type: item.type, number: item.number }
}
