export type WorkspaceCleanupView = 'ready' | 'review' | 'protected' | 'hidden'

export type WorkspaceCleanupViewCounts = Record<WorkspaceCleanupView, number>

export function resolveWorkspaceCleanupActiveView({
  requestedView,
  counts,
  open,
  loading,
  hasScan
}: {
  requestedView: WorkspaceCleanupView
  counts: WorkspaceCleanupViewCounts
  open: boolean
  loading: boolean
  hasScan: boolean
}): WorkspaceCleanupView {
  if (!open || loading || !hasScan || counts[requestedView] > 0) {
    return requestedView
  }
  if (counts.ready > 0) {
    return 'ready'
  }
  if (counts.review > 0) {
    return 'review'
  }
  if (counts.protected > 0) {
    return 'protected'
  }
  if (counts.hidden > 0) {
    return 'hidden'
  }
  return requestedView
}
