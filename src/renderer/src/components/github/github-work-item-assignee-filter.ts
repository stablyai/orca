import type { GitHubAssignableUser } from '../../../../shared/types'

export function filterGitHubWorkItemAssignees(
  assignees: readonly GitHubAssignableUser[],
  query: string
): GitHubAssignableUser[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return [...assignees]
  }
  return assignees.filter(
    (user) =>
      user.login.toLowerCase().includes(normalizedQuery) ||
      (user.name ?? '').toLowerCase().includes(normalizedQuery)
  )
}
