import type { TaskPageMantisBTProjectListModel } from './use-task-page-mantisbt-project-list'
import { useMemo } from 'react'
import { findTaskPageMantisBTIssue } from '@/components/task-page-mantisbt-cache-selectors'
import { sortMantisBTIssues } from './mantisbt-issue-sorter'
import type { MantisBTIssue } from '../../../shared/mantisbt-types'

export type TaskPageMantisBTListProjectionModel = TaskPageMantisBTProjectListModel & {
  fetchedMantisBTIssues: MantisBTIssue[]
  displayedMantisBTIssues: MantisBTIssue[]
  sortedMantisBTIssues: MantisBTIssue[]
}

export function useTaskPageMantisBTListProjection(
  model: TaskPageMantisBTProjectListModel
): TaskPageMantisBTListProjectionModel {
  const {
    mantisBTTaskSourceContext,
    mantisBTCacheSnapshot,
    mantisBTIssues,
    mantisBTOrderBy,
    mantisBTOrderDirection,
    mantisBTSearchInput
  } = model
  const reconciledMantisBTIssues = useMemo(
    () =>
      mantisBTIssues.map(
        (issue) =>
          findTaskPageMantisBTIssue(
            mantisBTCacheSnapshot.issueCache,
            mantisBTCacheSnapshot.searchCache,
            issue.id,
            { sourceContext: mantisBTTaskSourceContext, siteId: issue.siteId }
          ) ?? issue
      ),
    [
      mantisBTIssues,
      mantisBTCacheSnapshot.issueCache,
      mantisBTCacheSnapshot.searchCache,
      mantisBTTaskSourceContext
    ]
  )
  // Why: MantisBT has no server-side JQL-equivalent search RPC, so the search
  // box filters the already-fetched preset list client-side by substring.
  const trimmedSearch = mantisBTSearchInput.trim().toLowerCase()
  const displayedMantisBTIssues = useMemo(() => {
    if (!trimmedSearch) {
      return reconciledMantisBTIssues
    }
    return reconciledMantisBTIssues.filter(
      (issue) =>
        issue.summary.toLowerCase().includes(trimmedSearch) ||
        (issue.description?.toLowerCase().includes(trimmedSearch) ?? false)
    )
  }, [reconciledMantisBTIssues, trimmedSearch])
  const sortedMantisBTIssues = useMemo(
    () => sortMantisBTIssues(displayedMantisBTIssues, mantisBTOrderBy, mantisBTOrderDirection),
    [displayedMantisBTIssues, mantisBTOrderBy, mantisBTOrderDirection]
  )
  return {
    ...model,
    fetchedMantisBTIssues: reconciledMantisBTIssues,
    displayedMantisBTIssues,
    sortedMantisBTIssues
  }
}
