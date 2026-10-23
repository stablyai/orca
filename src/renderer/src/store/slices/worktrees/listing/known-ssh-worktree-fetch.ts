import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import type {
  HostQualifiedKnownWorktreeResult,
  SshExecutionHostId
} from '../../../../../../shared/detected-worktree-provider-contract'
import { areDetectedWorktreeResultsEqual, areWorktreesEqual } from './worktree-catalog-visibility'
import {
  getProjectHostSetupForRepoHost,
  repoHasExactlyOneExecutionHostOwner,
  toVisibleWorktrees,
  withRepoHostOwnership,
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from './worktree-host-ownership'
import { getCurrentDirectSshAuthority } from './direct-ssh-authority'
import { isDetectedWorktreeListResult } from './detected-worktree-provider-request'
import { getAuthoritativelyRemovedWorktreeIds } from './authoritative-worktree-removal-memory'
import type { WorktreeHostMatchOptions } from './worktree-slice-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export function appendMissingWorktreesForHost<
  T extends { id: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
>(
  current: readonly T[] | undefined,
  incoming: readonly T[],
  hostId: ExecutionHostId,
  options: WorktreeHostMatchOptions
): T[] {
  const existing = current ?? []
  const existingHostIds = new Set(
    existing
      .filter((worktree) => worktreeMatchesHost(worktree, hostId, options))
      .map(({ id }) => id)
  )
  const missing = incoming.filter((worktree) => !existingHostIds.has(worktree.id))
  if (missing.length === 0) {
    return [...existing]
  }
  // Why: land inside the host's block like mergeWorktreesForHost does, else these rows sit past sibling hosts and visibly jump once the authoritative scan splices them back.
  const lastHostIndex = existing.findLastIndex((worktree) =>
    worktreeMatchesHost(worktree, hostId, options)
  )
  if (lastHostIndex === -1) {
    return [...existing, ...missing]
  }
  return [...existing.slice(0, lastHostIndex + 1), ...missing, ...existing.slice(lastHostIndex + 1)]
}

export function isAdmittedKnownSshWorktreeResult(
  result: HostQualifiedKnownWorktreeResult,
  repoId: string,
  executionHostId: SshExecutionHostId
): result is Extract<HostQualifiedKnownWorktreeResult, { status: 'complete' }> {
  return (
    result.status === 'complete' &&
    result.repoId === repoId &&
    result.executionHostId === executionHostId &&
    isDetectedWorktreeListResult(result.result) &&
    result.result.repoId === repoId &&
    result.result.authoritative === false
  )
}

const inflightKnownSshWorktreeFetches = new Map<
  string,
  Promise<DetectedWorktreeListResult | null>
>()

// Why: the authoritative path dedupes through listDetectedWorktreesForRepoCoalesced; without a matching guard
// the four refresh triggers can each issue this IPC and its merge for the same repo/host.
export async function fetchKnownSshWorktreesForRepo(
  set: Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
  repoId: string,
  executionHostId: SshExecutionHostId
): Promise<DetectedWorktreeListResult | null> {
  const coalesceKey = `${repoId}\0${executionHostId}`
  const inflight = inflightKnownSshWorktreeFetches.get(coalesceKey)
  if (inflight) {
    return await inflight
  }
  const request = runKnownSshWorktreeFetch(set, repoId, executionHostId).finally(() => {
    inflightKnownSshWorktreeFetches.delete(coalesceKey)
  })
  inflightKnownSshWorktreeFetches.set(coalesceKey, request)
  return await request
}

export async function runKnownSshWorktreeFetch(
  set: Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0],
  repoId: string,
  executionHostId: SshExecutionHostId
): Promise<DetectedWorktreeListResult | null> {
  // Why: reads the local store only, so a runtime-hub session (whose repo ids live on the hub) always gets 'rejected' and keeps the pre-existing no-op.
  const listKnown = window.api.worktrees.listKnownForExecutionHost
  if (typeof listKnown !== 'function') {
    return null
  }
  const result = await listKnown({ repoId, executionHostId })
  if (!isAdmittedKnownSshWorktreeResult(result, repoId, executionHostId)) {
    return null
  }
  // Why: persisted SSH metadata outlives the remote worktree, so drop rows a completed scan already proved gone.
  const suppressedIds = getAuthoritativelyRemovedWorktreeIds(executionHostId)
  const known =
    suppressedIds && suppressedIds.size > 0
      ? {
          ...result.result,
          worktrees: result.result.worktrees.filter((worktree) => !suppressedIds.has(worktree.id))
        }
      : result.result
  let admitted = false
  set((state) => {
    // Why: the provider can connect during the await; authoritative rows already replaced this host, so appending stale metadata would resurrect purged worktrees.
    if (
      getCurrentDirectSshAuthority(state, executionHostId) ||
      !repoHasExactlyOneExecutionHostOwner(state, repoId, executionHostId, false)
    ) {
      return state
    }
    admitted = true
    const setup = getProjectHostSetupForRepoHost(state, repoId, executionHostId)
    const matchOptions = worktreeHostMatchOptions(state, repoId, executionHostId)
    const incomingDetected = known.worktrees.map((worktree) =>
      withRepoHostOwnership(worktree, executionHostId, setup)
    )
    const priorDetected = state.detectedWorktreesByRepo[repoId]
    // Why: only the rows are ours to merge. This entry is keyed by repo alone, so adopting the fallback's
    // authoritative/source would demote a sibling host's completed scan and blank every authoritative-gated surface.
    const detected = {
      ...(priorDetected ?? known),
      worktrees: appendMissingWorktreesForHost(
        priorDetected?.worktrees,
        incomingDetected,
        executionHostId,
        matchOptions
      )
    }
    const worktrees = appendMissingWorktreesForHost(
      state.worktreesByRepo[repoId],
      toVisibleWorktrees(known, executionHostId, setup),
      executionHostId,
      matchOptions
    )
    const worktreesChanged = !areWorktreesEqual(state.worktreesByRepo[repoId], worktrees)
    const detectedChanged = !areDetectedWorktreeResultsEqual(
      state.detectedWorktreesByRepo[repoId],
      detected
    )
    if (!worktreesChanged && !detectedChanged) {
      return state
    }
    return {
      ...(worktreesChanged
        ? {
            worktreesByRepo: { ...state.worktreesByRepo, [repoId]: worktrees },
            sortEpoch: state.sortEpoch + 1
          }
        : {}),
      ...(detectedChanged
        ? { detectedWorktreesByRepo: { ...state.detectedWorktreesByRepo, [repoId]: detected } }
        : {})
    }
  })
  return admitted ? known : null
}
