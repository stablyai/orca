import type { LaunchableWorkItem } from '@/lib/launch-work-item-direct-types'
import type { PersistedIssueSourcePreference, Repo } from '../../../shared/types'

export function getLinkedIssueSourcePreference(
  item: LaunchableWorkItem,
  repo: Repo
): PersistedIssueSourcePreference | undefined {
  // Why: worktree metadata must remember the source repo for linked GitHub
  // issues so later board sync writes cannot drift with the task selector.
  if (
    item.type === 'issue' &&
    item.number &&
    (item.issueSourcePreference === 'origin' || item.issueSourcePreference === 'upstream')
  ) {
    return item.issueSourcePreference
  }
  if (
    item.type === 'issue' &&
    item.number &&
    (repo.issueSourcePreference === 'origin' || repo.issueSourcePreference === 'upstream')
  ) {
    return repo.issueSourcePreference
  }
  return undefined
}
