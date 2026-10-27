import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export function sanitizeWebRuntimeWorkspaceSession(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  const defaults = getDefaultWorkspaceSession()
  return {
    ...defaults,
    // Host supplies live tabs; browser-persisted handles replay stale selectors after re-pair or host restart.
    activeRepoId: session.activeRepoId ?? null,
    activeWorktreeId: session.activeWorktreeId ?? null,
    browserUrlHistory: session.browserUrlHistory ?? defaults.browserUrlHistory,
    lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId
  }
}
