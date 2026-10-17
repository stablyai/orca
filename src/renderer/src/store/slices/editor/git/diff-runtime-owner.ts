import type { AppState } from '../../../types'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'

export function resolveDiffRuntimeEnvironmentId(
  state: AppState,
  worktreeId: string,
  explicitRuntimeEnvironmentId: string | null | undefined
): string | null | undefined {
  if (explicitRuntimeEnvironmentId !== undefined) {
    return explicitRuntimeEnvironmentId
  }
  // Why: route diffs by explicit worktree owner; null forces LOCAL, undefined would inherit the focused runtime → wrong host (#6957, #8484).
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
  // Why: a diff only reads, so a twin shows this app's copy, never the focused server's.
  return owner.kind === 'resolved' ? owner.environmentId : null
}
