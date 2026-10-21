import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { WORKSPACE_UNREAD_HOST_RAISES_CAPABILITY } from '../../../../../../shared/workspace-unread-raise-capability'
import {
  readCachedRuntimeEnvironmentCapability,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import type { AppState } from '../../../types'
import { tryRuntimeTargetForWorktreeOwner } from './worktree-owner-target'

/**
 * Whether the workspace's owning host runs main's sidebar inputs, so it raises the unread flag
 * itself. A local owner runs this build (main, its SSH hosts, or the host that served the browser
 * client). A paired server answers by capability; an unresolved owner or an unreadable status
 * counts as older, so this window raises the flag.
 */
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
