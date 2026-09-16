import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import {
  canOpenWorkspaceBrowserTabOnRuntime,
  canOpenWorkspaceBrowserTabOnSsh
} from '@/lib/workspace-browser-tab-open'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'

/** The chat transcript has no PTY, so link ownership comes from the session's
 *  workspace: a runtime id wins, then an SSH connection; an unresolved owner
 *  stays 'unknown' rather than claiming local. */
export function resolveNativeChatHttpLinkSourceOwner(
  state: AppState,
  worktreeId: string
): HttpLinkSourceOwner {
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (runtimeEnvironmentId) {
    return { kind: 'runtime', runtimeEnvironmentId }
  }
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId === undefined) {
    return { kind: 'unknown' }
  }
  return connectionId === null ? { kind: 'local' } : { kind: 'ssh', connectionId }
}

export function canNativeChatOpenOwnedBrowser(
  state: AppState,
  worktreeId: string,
  sourceOwner: HttpLinkSourceOwner
): boolean {
  if (sourceOwner.kind === 'runtime') {
    return canOpenWorkspaceBrowserTabOnRuntime(state, worktreeId, sourceOwner.runtimeEnvironmentId)
  }
  return (
    sourceOwner.kind === 'ssh' &&
    canOpenWorkspaceBrowserTabOnSsh(state, worktreeId, sourceOwner.connectionId)
  )
}
