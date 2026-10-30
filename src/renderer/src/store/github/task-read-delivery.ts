import {
  sameGitHubTaskObservation,
  patchObservedGitHubWorkItem,
  getGitHubTaskObservation,
  gitHubTaskFamilyOrigin
} from '@/lib/github-task-observation'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { rowKey, dependency } from './task-read-program'

export function materializeGitHubTaskDelivery(
  current: GitHubWorkItem[],
  next: GitHubWorkItem[],
  prior: GitHubWorkItem[] | undefined,
  previousRows: ReadonlyMap<string, GitHubWorkItem>,
  fields: ReadonlyMap<string, ReadonlySet<keyof GitHubWorkItem>>,
  dependencies: ReadonlySet<string>
): GitHubWorkItem[] {
  if (!current.length || current === prior) {
    return next
  }
  const index = new Map(current.map((row) => [rowKey(row), row]))
  return next.map((row) => {
    const independent = index.get(rowKey(row)) ?? index.get(rowKey(row, ''))
    if (
      !independent ||
      independent === row ||
      independent === previousRows.get(rowKey(row)) ||
      (getGitHubTaskObservation(independent) &&
        !sameGitHubTaskObservation(
          getGitHubTaskObservation(independent),
          getGitHubTaskObservation(row)
        ))
    ) {
      return row
    }
    let result = row
    const content = fields.get(rowKey(row))
    if (content?.size) {
      result = patchObservedGitHubWorkItem(
        result,
        Object.fromEntries(
          [...content]
            .filter((field) => field !== 'assignees' && field !== 'reviewRequests')
            .map((field) => [field, independent[field]])
        ),
        {
          ...(content.has('state') ? { state: independent.githubValueOrigins?.state } : {}),
          ...(content.has('autoMergeEnabled')
            ? { autoMerge: independent.githubValueOrigins?.autoMerge }
            : {})
        }
      )
    }
    for (const family of ['assignees', 'reviewRequests'] as const) {
      if (dependencies.has(dependency(row, family)) || content?.has(family)) {
        result = patchObservedGitHubWorkItem(
          result,
          { [family]: independent[family] },
          { [family]: gitHubTaskFamilyOrigin(independent, family) }
        )
      }
    }
    return result
  })
}
