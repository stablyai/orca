import { useAppStore } from '@/store'
import { getActiveWorkspaceOwnerTarget } from '@/lib/workspace/ownership/resolved-worktree-execution-host'

/**
 * Reads whose own params already say nobody asked for them: a background admission tier (git
 * status safety ticks, interval branch compares, unselected review reads) or a timer's
 * stale-while-revalidate read the user did not refresh (PR and checks polls). They are no use of an
 * idle WSL host and never wake one Orca stopped idle (#46567).
 */
export function isBackgroundRuntimeRead(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) {
    return false
  }
  if ('admissionTier' in params && params.admissionTier === 'background') {
    return true
  }
  return (
    'reason' in params &&
    params.reason === 'swr' &&
    !('userRefresh' in params && params.userRefresh === true)
  )
}

/** A click or key in the last few seconds while this host owns the focused workspace: typing in
 *  another workspace must not wake an idle-stopped WSL host some background call targets. */
export function hasRecentUserGestureFor(environmentId: string): boolean {
  if (typeof navigator === 'undefined' || navigator.userActivation?.isActive !== true) {
    return false
  }
  const owner = getActiveWorkspaceOwnerTarget(useAppStore.getState())
  return owner?.kind === 'environment' && owner.environmentId === environmentId
}
