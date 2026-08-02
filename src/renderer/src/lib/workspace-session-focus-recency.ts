import type { WorkspaceSessionState } from '../../../shared/types'

export function buildLastVisitedAtByWorktreeId(snapshot: {
  lastVisitedAtByWorktreeId: WorkspaceSessionState['lastVisitedAtByWorktreeId']
}): WorkspaceSessionState['lastVisitedAtByWorktreeId'] {
  return snapshot.lastVisitedAtByWorktreeId &&
    Object.keys(snapshot.lastVisitedAtByWorktreeId).length > 0
    ? snapshot.lastVisitedAtByWorktreeId
    : undefined
}
