import type { CacheEntry } from '@/store/slices/github'
import type { JiraIssue } from '../../../shared/types'

type JiraIssueCache = Record<string, CacheEntry<JiraIssue>>
type JiraSearchCache = Record<string, CacheEntry<JiraIssue[]>>

export function findTaskPageJiraIssue(
  jiraIssueCache: JiraIssueCache,
  jiraSearchCache: JiraSearchCache,
  jiraIssueKey: string | null
): JiraIssue | null {
  if (!jiraIssueKey) {
    return null
  }

  for (const entry of Object.values(jiraIssueCache)) {
    if (entry?.data?.key === jiraIssueKey) {
      return entry.data
    }
  }

  for (const entry of Object.values(jiraSearchCache)) {
    const found = entry?.data?.find((issue) => issue.key === jiraIssueKey)
    if (found) {
      return found
    }
  }

  return null
}
