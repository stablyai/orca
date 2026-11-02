import {
  getExecutionHostLabel,
  isUnresolvedOwnerHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getHostSettingOverride } from '../../../shared/host-setting-overrides'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { selectRuntimeAwareSshTargetLabel } from '@/store/slices/runtime-environment-ssh-selectors'
import type { AppState } from '@/store/types'

/** Prefer the user rename, then published machine/SSH label, then raw host ID. */
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

/** Return null for contested ownership; unresolved-owner is routing bookkeeping, never a user-visible machine name. */
export function selectWorktreeHostDisplayLabel(state: AppState, worktreeId: string): string | null {
  const hostId = getExecutionHostIdForWorktree(state, worktreeId)
  if (isUnresolvedOwnerHostId(hostId)) {
    return null
  }
  const parsed = parseExecutionHostId(hostId)
  return selectExecutionHostDisplayLabel(state, hostId, {
    // Why: a label only reads; a twin names the direct SSH target.
    sshEnvironmentId:
      parsed?.kind === 'ssh' ? runtimeEnvironmentIdUnlessTwin(state, worktreeId) : null
  })
}
