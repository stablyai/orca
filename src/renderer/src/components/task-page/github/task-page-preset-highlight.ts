import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubTaskKind } from '../../../../../shared/task-github-search'
import type { TaskViewPresetId } from '../../../../../shared/ui-chrome-types'
export function deriveGitHubTaskPreset(
  kind: GitHubTaskKind,
  query: ParsedTaskQuery
): TaskViewPresetId | null {
  if (query.state !== 'open') {
    return null
  }
  if (kind === 'prs') {
    if (query.author?.toLowerCase() === '@me') {
      return 'my-prs'
    }
    if (query.reviewRequested?.toLowerCase() === '@me') {
      return 'review'
    }
  } else if (query.assignee?.toLowerCase() === '@me') {
    return 'my-issues'
  }
  return query.author !== null ||
    query.assignee !== null ||
    query.reviewRequested !== null ||
    query.reviewedBy !== null
    ? null
    : kind === 'prs'
      ? 'prs'
      : 'issues'
}
