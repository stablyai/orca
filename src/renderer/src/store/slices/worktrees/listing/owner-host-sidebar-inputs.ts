import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../../../../../shared/workspace-unread-raise-capability'
import {
  readCachedRuntimeEnvironmentCapability,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import type { AppState } from '../../../types'
import { tryRuntimeTargetForWorktreeOwner } from './worktree-owner-target'

/** Local/SSH/serving-web owners run this build; paired hosts prove sidebar-input ownership by capability. Unknown/unreadable owners use window flag fallback. */
export async function ownerHostOwnsSidebarInputs(
  state: AppState,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Promise<boolean> {
  const target = tryRuntimeTargetForWorktreeOwner(state, worktreeId, executionHostId)
  if (!target) {
    return false
  }
  if (target.kind === 'local') {
    return true
  }
  // Why the cached answer first: a per-write probe would delay the flag past a screen arrival.
  const cached = readCachedRuntimeEnvironmentCapability(
    target.environmentId,
    WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY
  )
  if (cached !== null) {
    return cached
  }
  return runtimeEnvironmentSupportsCapability(
    target.environmentId,
    WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY
  ).catch(() => false)
}
