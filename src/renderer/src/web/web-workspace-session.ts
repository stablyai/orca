import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/types'

export function sanitizeWebRuntimeWorkspaceSession(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  const defaults = getDefaultWorkspaceSession()
  return {
    ...defaults,
    // Why: paired web clients get live tabs from the host runtime. Persisting
    // those remote handles in browser storage replays stale terminal/browser
    // selectors after a new pairing or host restart.
    activeRepoId: session.activeRepoId ?? null,
    activeWorktreeId: session.activeWorktreeId ?? null,
    browserUrlHistory: session.browserUrlHistory ?? defaults.browserUrlHistory,
    lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId
  }
}
