import {
  getExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getHostSettingOverride } from '../../../shared/host-setting-overrides'
import {
  getExecutionHostIdForWorktree,
  getExplicitRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { selectRuntimeAwareSshTargetLabel } from '@/store/slices/runtime-environment-ssh-selectors'
import type { AppState } from '@/store/types'

/**
 * What to call an execution host in front of a user: their own rename first, then the machine's
 * published name (paired runtime) or the SSH target's label, and the raw id only as a last resort.
 */
export function selectExecutionHostDisplayLabel(
  state: AppState,
  hostId: ExecutionHostId,
  // SSH labels are published per runtime environment when the target is reached through one.
  options: { sshEnvironmentId?: string | null } = {}
): string {
  const override = getHostSettingOverride(state.settings, hostId, 'displayLabel')
  if (override) {
    return override
  }
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'runtime') {
    const name = state.runtimeEnvironments
      ?.find((environment) => environment.id === parsed.environmentId)
      ?.name.trim()
    if (name) {
      return name
    }
  }
  if (parsed?.kind === 'ssh') {
    return selectRuntimeAwareSshTargetLabel(
      state,
      options.sshEnvironmentId ?? null,
      parsed.targetId
    )
  }
  return getExecutionHostLabel(hostId)
}

/**
 * The machine a worktree's files live on, or null when ownership is still contested — the
 * `unresolved-owner` sentinel is routing bookkeeping and must never reach a reader as a host name.
 */
export function selectWorktreeHostDisplayLabel(state: AppState, worktreeId: string): string | null {
  const hostId = getExecutionHostIdForWorktree(state, worktreeId)
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'runtime' && parsed.environmentId === 'unresolved-owner') {
    return null
  }
  return selectExecutionHostDisplayLabel(state, hostId, {
    sshEnvironmentId:
      parsed?.kind === 'ssh' ? getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId) : null
  })
}
