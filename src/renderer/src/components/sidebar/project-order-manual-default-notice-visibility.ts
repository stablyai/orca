import type { WorkspaceGroupBy } from '../../../../shared/workspace-group-by'
export function shouldShowProjectOrderManualDefaultNotice(args: {
  persistedUIReady: boolean
  projectOrderManualDefaultNoticeDismissed: boolean
  groupBy: WorkspaceGroupBy
  projectOrderBy: 'manual' | 'recent'
  repoCount: number
}): boolean {
  return (
    args.persistedUIReady &&
    !args.projectOrderManualDefaultNoticeDismissed &&
    args.groupBy === 'repo' &&
    args.projectOrderBy === 'manual' &&
    args.repoCount > 0
  )
}
