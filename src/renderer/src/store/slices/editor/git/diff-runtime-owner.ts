import type { AppState } from '../../../types'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'

export function resolveDiffRuntimeEnvironmentId(
  state: AppState,
  worktreeId: string,
  explicitRuntimeEnvironmentId: string | null | undefined
): string | null | undefined {
  if (explicitRuntimeEnvironmentId !== undefined) {
    return explicitRuntimeEnvironmentId
  }
  // Explicit owner routes reads; null forces local while undefined follows focused runtime and can hit wrong host (#6957, #8484).
  return runtimeEnvironmentIdUnlessTwin(state, worktreeId)
}
