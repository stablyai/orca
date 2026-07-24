import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import type {
  GitHubProjectSettings,
  GitHubProjectSummary
} from '../../../../shared/github-project-types'
import { githubProjectIdentityKey } from '../../../../shared/github-project-identity'

export const GITHUB_PROJECT_PICKER_QUERY_MAX_BYTES = 2 * 1024

export function isGitHubProjectPickerQueryTooLarge(
  query: string,
  maxBytes = GITHUB_PROJECT_PICKER_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

function getProjectKey(
  project: Pick<GitHubProjectSummary, 'ownerType' | 'owner' | 'number' | 'host'>
): string {
  return githubProjectIdentityKey(project)
}

export function filterGitHubProjectPickerProjects({
  projects,
  pinned,
  recent,
  query
}: {
  projects: readonly GitHubProjectSummary[]
  pinned: readonly GitHubProjectSettings['pinned'][number][]
  recent: readonly GitHubProjectSettings['recent'][number][]
  query: string
}): GitHubProjectSummary[] {
  if (isGitHubProjectPickerQueryTooLarge(query)) {
    return []
  }
  const trimmedQuery = query.trim()

  const pinnedKeys = new Set(pinned.map(getProjectKey))
  const recentKeys = new Set(recent.map(getProjectKey))
  const normalizedQuery = trimmedQuery.toLowerCase()

  return projects.filter((project) => {
    const key = getProjectKey(project)
    if (pinnedKeys.has(key) || recentKeys.has(key)) {
      return false
    }
    if (!normalizedQuery) {
      return true
    }
    return (
      project.title.toLowerCase().includes(normalizedQuery) ||
      project.owner.toLowerCase().includes(normalizedQuery) ||
      String(project.number).includes(normalizedQuery)
    )
  })
}
