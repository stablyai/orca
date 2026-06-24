import type { IssueSourcePreference, PersistedIssueSourcePreference } from '../../../shared/types'

export function resolvePersistedGitHubIssueSourcePreference(
  itemPreference: PersistedIssueSourcePreference | null | undefined,
  repoPreference: IssueSourcePreference | null | undefined
): PersistedIssueSourcePreference | undefined {
  if (itemPreference === 'origin' || itemPreference === 'upstream') {
    return itemPreference
  }
  if (repoPreference === 'origin' || repoPreference === 'upstream') {
    return repoPreference
  }
  return undefined
}
