import { useMemo } from 'react'
import { useAppStore } from '../../store/index'
import { getKnownExecutionHostIdForWorktree } from '../../lib/workspace/ownership/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '../../lib/workspace/ownership/worktree-runtime-owner-state'
import { runtimeTargetForOwnerEnvironment } from '../../runtime/rpc/targets/runtime-client-target'
import { parseRoutableExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/**
 * The focused workspace's machine: `''` is this app, otherwise a server's environment id. `null`
 * hides agent updates: an unproven owner or a direct SSH host must never show this machine's agents.
 */
export function agentUpdatesOwnerKey(state: WorktreeRuntimeOwnerState): string | null {
  const host = parseRoutableExecutionHostId(
    getKnownExecutionHostIdForWorktree(state, state.activeWorktreeId)
  )
  if (!host || host.kind === 'ssh') {
    return null
  }
  return host.kind === 'runtime' ? host.environmentId : ''
}

export function useAgentUpdatesOwner(): RuntimeClientTarget | null {
  const key = useAppStore(agentUpdatesOwnerKey)
  return useMemo(() => (key === null ? null : runtimeTargetForOwnerEnvironment(key || null)), [key])
}
