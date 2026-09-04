import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '../../../types'
import type { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import {
  settingsForDirectOwner,
  settingsForRuntimeEnvironmentOwner
} from '../listing/worktree-owner-settings'

type PinnedOwnerRouting = {
  /** Settings to persist through, or undefined to use the id-and-host owner lookup. */
  pinnedSettings: AppState['settings'] | undefined
  /** Where a recovery refetch must go after a failure, or undefined for the default. */
  recoveryFetchOptions: { executionHostId: ExecutionHostId } | undefined
}

/**
 * How an identity-pinned row reaches its host.
 *
 * Why: two paired runtimes can publish one checkout as rows sharing id and physical host, and the
 * desktop can list the same checkout directly as well. A row with a paired-runtime owner goes
 * through that runtime; a row without one is listed by the desktop itself and must not fall back
 * to the id-and-host guess, which can pick a HUB that also proxies the checkout and would reject the
 * desktop row's identity selector. Recovery after a failure follows the same owner, or the failed
 * optimistic value stays on screen.
 */
export function resolvePinnedOwnerRouting(
  settings: AppState['settings'],
  requestedIdentityKey: string | undefined,
  pinnedCandidate: ReturnType<typeof findKnownWorktreeById>,
  executionHostId: ExecutionHostId | undefined,
  /** Owner named by the caller for a row that has no canonical identity yet; `null` names the row
   *  the desktop lists itself. */
  requestedRuntimeOwnerEnvironmentId?: string | null
): PinnedOwnerRouting {
  // Why the second clause: a detected-only nested-SSH row carries no identity, but the caller
  // knows which HUB it came from, and that alone is enough to route the write correctly.
  if (requestedIdentityKey === undefined && requestedRuntimeOwnerEnvironmentId !== undefined) {
    // Why null routes direct: the caller says the desktop lists this row itself, so the id-and-host
    // guess, which can pick a HUB proxying the same checkout, must not be consulted.
    return requestedRuntimeOwnerEnvironmentId === null
      ? directRouting(settings, executionHostId ?? hostOf(pinnedCandidate))
      : runtimeRouting(settings, requestedRuntimeOwnerEnvironmentId)
  }
  if (requestedIdentityKey === undefined || !pinnedCandidate) {
    return { pinnedSettings: undefined, recoveryFetchOptions: undefined }
  }
  const ownerEnvironmentId = hostFields(pinnedCandidate)?.runtimeOwnerEnvironmentId
  return ownerEnvironmentId
    ? runtimeRouting(settings, ownerEnvironmentId)
    : directRouting(settings, executionHostId ?? hostOf(pinnedCandidate))
}

function runtimeRouting(settings: AppState['settings'], environmentId: string): PinnedOwnerRouting {
  return {
    pinnedSettings: settingsForRuntimeEnvironmentOwner(settings, environmentId),
    recoveryFetchOptions: { executionHostId: toRuntimeExecutionHostId(environmentId) }
  }
}

function directRouting(
  settings: AppState['settings'],
  directHost: ExecutionHostId | undefined
): PinnedOwnerRouting {
  return {
    pinnedSettings: settingsForDirectOwner(settings),
    recoveryFetchOptions: directHost ? { executionHostId: directHost } : undefined
  }
}

function hostFields(
  candidate: ReturnType<typeof findKnownWorktreeById>
): Partial<Pick<Worktree, 'runtimeOwnerEnvironmentId' | 'hostId'>> | undefined {
  return candidate
}

function hostOf(candidate: ReturnType<typeof findKnownWorktreeById>): ExecutionHostId | undefined {
  return hostFields(candidate)?.hostId
}
