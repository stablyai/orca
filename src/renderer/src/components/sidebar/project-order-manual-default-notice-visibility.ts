export function shouldShowProjectOrderManualDefaultNotice(args: {
  persistedUIReady: boolean
  projectOrderManualDefaultNoticeDismissed: boolean
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status'
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
