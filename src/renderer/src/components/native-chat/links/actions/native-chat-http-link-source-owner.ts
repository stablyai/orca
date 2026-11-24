import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import type { HttpLinkSourceOwner } from '@/lib/browser/navigation/http-link-routing'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { AppState } from '@/store/types'

/** Without a PTY, resolve runtime then SSH from the workspace; unresolved ownership remains unknown. */
export function resolveNativeChatHttpLinkSourceOwner(
  state: AppState,
  worktreeId: string
): HttpLinkSourceOwner {
  const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  if (runtimeEnvironmentId) {
    return { kind: 'runtime', runtimeEnvironmentId }
  }
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId === undefined) {
    return { kind: 'unknown' }
  }
  return connectionId === null ? { kind: 'local' } : { kind: 'ssh', connectionId }
}
