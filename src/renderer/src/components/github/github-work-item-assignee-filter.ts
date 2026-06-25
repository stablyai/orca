import type { GitHubAssignableUser } from '../../../../shared/types'
import { isGitHubWorkItemOptionFilterQueryTooLarge } from './github-work-item-option-filter-bounds'

export function filterGitHubWorkItemAssignees(
  assignees: readonly GitHubAssignableUser[],
  query: string
): GitHubAssignableUser[] {
  if (isGitHubWorkItemOptionFilterQueryTooLarge(query)) {
    return []
  }
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return [...assignees]
  }
  const normalizedQuery = trimmedQuery.toLowerCase()
  return assignees.filter(
    (user) =>
      user.login.toLowerCase().includes(normalizedQuery) ||
      (user.name ?? '').toLowerCase().includes(normalizedQuery)
  )
}
