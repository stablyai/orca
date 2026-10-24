import type { ProjectOrderBy } from '../../../../shared/ui-chrome-types'

export function shouldShowProjectOrderManualDefaultNotice(args: {
  persistedUIReady: boolean
  projectOrderManualDefaultNoticeDismissed: boolean
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  projectOrderBy: ProjectOrderBy
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
