import { isGitHubWorkItemOptionFilterQueryTooLarge } from './github-work-item-option-filter-bounds'

export function filterGitHubWorkItemLabels(labels: readonly string[], query: string): string[] {
  if (isGitHubWorkItemOptionFilterQueryTooLarge(query)) {
    return []
  }
  const trimmedQuery = query.trim()
  if (!trimmedQuery) {
    return [...labels]
  }
  const normalizedQuery = trimmedQuery.toLowerCase()
  return labels.filter((label) => label.toLowerCase().includes(normalizedQuery))
}
