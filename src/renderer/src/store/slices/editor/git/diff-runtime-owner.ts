import type { AppState } from '../../../types'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export function resolveDiffRuntimeEnvironmentId(
  state: AppState,
  worktreeId: string,
  explicitRuntimeEnvironmentId: string | null | undefined
): string | null | undefined {
  if (explicitRuntimeEnvironmentId !== undefined) {
    return explicitRuntimeEnvironmentId
  }
  // Why: route diffs by explicit worktree owner; null forces LOCAL, undefined would inherit the focused runtime → wrong host (#6957, #8484).
  return getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId) ?? null
}
