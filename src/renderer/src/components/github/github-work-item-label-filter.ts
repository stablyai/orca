export function filterGitHubWorkItemLabels(labels: readonly string[], query: string): string[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return [...labels]
  }
  return labels.filter((label) => label.toLowerCase().includes(normalizedQuery))
}
