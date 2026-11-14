import type { ParsedTaskQuery } from '../../../../../../shared/work-items/task-query'
import type { GitHubTaskKind } from '../../../../../../shared/work-items/task-github-search'
import type { TaskViewPresetId } from '../../../../../../shared/ui-chrome-types'
import { isOnlyMeAuthor } from './task-page-pr-chips'
export function deriveGitHubTaskPreset(
  kind: GitHubTaskKind,
  query: ParsedTaskQuery
): TaskViewPresetId | null {
  if (query.state !== 'open') {
    return null
  }
  if (kind === 'prs') {
    if (isOnlyMeAuthor(query)) {
      return 'my-prs'
    }
    if (query.reviewRequested?.toLowerCase() === '@me') {
      return 'review'
    }
  } else if (query.assignee?.toLowerCase() === '@me') {
    return 'my-issues'
  }
  return query.authors.length > 0 ||
    query.assignee !== null ||
    query.reviewRequested !== null ||
    query.reviewedBy !== null
    ? null
    : kind === 'prs'
      ? 'prs'
      : 'issues'
}
