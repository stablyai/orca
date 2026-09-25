import { requestVirtualizedScrollAnchorRecord } from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { getWorktreeOperationOwnerHostIds } from '@/lib/worktree-operation-route'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
import { resolveWorkspaceCleanupRemovalHostId } from '../../../../../../shared/workspace-cleanup-host-identity'
import { rememberAuthoritativelyRemovedWorktrees } from '../listing/authoritative-worktree-removal-memory'
import { worktreeHostMatchOptions, worktreeMatchesHost } from '../listing/worktree-host-ownership'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'

export function resolveSameIdSurvivingHostId(
  state: ReturnType<WorktreeSliceGet>,
  worktreeId: string,
  requiredExecutionHostId: ExecutionHostId | null,
  ignoreWorkspaceCleanupScanSurvivors = false
): ExecutionHostId | null {
  if (requiredExecutionHostId === null) {
    return null
  }
  const catalogHostId = getWorktreeOperationOwnerHostIds(state, worktreeId).find(
    (ownerHostId) => ownerHostId !== requiredExecutionHostId
  )
  if (catalogHostId) {
    return catalogHostId
  }
  if (
    state.activeWorktreeId === worktreeId &&
    state.activeWorkspaceExecutionHostId !== null &&
    state.activeWorkspaceExecutionHostId !== requiredExecutionHostId
  ) {
    return state.activeWorkspaceExecutionHostId
  }
  if (ignoreWorkspaceCleanupScanSurvivors) {
    return null
  }
  return (
    state.workspaceCleanupScan?.candidates
      .map((candidate) => ({ candidate, hostId: resolveWorkspaceCleanupRemovalHostId(candidate) }))
      .find(
        ({ candidate, hostId }) =>
          candidate.worktreeId === worktreeId &&
          hostId !== null &&
          hostId !== requiredExecutionHostId
      )?.hostId ?? null
  )
}

export function preservesSameIdRendererState(
  state: ReturnType<WorktreeSliceGet>,
  worktreeId: string,
  requiredExecutionHostId: ExecutionHostId | null
): boolean {
  return resolveSameIdSurvivingHostId(state, worktreeId, requiredExecutionHostId) !== null
}

export function dropConfirmedHostRow(
  set: WorktreeSliceSet,
  worktreeId: string,
  requiredExecutionHostId: ExecutionHostId,
  fallbackSurvivingHostId: ExecutionHostId | null = null,
  ignoreWorkspaceCleanupScanSurvivors = false
): boolean {
  let sameIdSurvives = false
  requestVirtualizedScrollAnchorRecord('[data-worktree-sidebar]')
  set((state) => {
    const removedActiveHost =
      state.activeWorktreeId === worktreeId &&
      state.activeWorkspaceExecutionHostId === requiredExecutionHostId
    const scanSurvivingHostId = ignoreWorkspaceCleanupScanSurvivors
      ? undefined
      : state.workspaceCleanupScan?.candidates
          .filter((candidate) => candidate.worktreeId === worktreeId)
          .map(resolveWorkspaceCleanupRemovalHostId)
          .find(
            (ownerHostId): ownerHostId is ExecutionHostId =>
              ownerHostId !== null && ownerHostId !== requiredExecutionHostId
          )
    const survivingHostId = removedActiveHost
      ? (getWorktreeOperationOwnerHostIds(state, worktreeId).find(
          (ownerHostId) => ownerHostId !== requiredExecutionHostId
        ) ??
        scanSurvivingHostId ??
        fallbackSurvivingHostId)
      : null
    const nextWorktreesByRepo = { ...state.worktreesByRepo }
    for (const [candidateRepoId, worktrees] of Object.entries(nextWorktreesByRepo)) {
      const matchOptions = worktreeHostMatchOptions(state, candidateRepoId, requiredExecutionHostId)
      nextWorktreesByRepo[candidateRepoId] = worktrees.filter(
        (worktree) =>
          worktree.id !== worktreeId ||
          !worktreeMatchesHost(worktree, requiredExecutionHostId, matchOptions)
      )
    }
    let nextDetectedWorktreesByRepo = state.detectedWorktreesByRepo
    for (const [candidateRepoId, result] of Object.entries(state.detectedWorktreesByRepo)) {
      const matchOptions = worktreeHostMatchOptions(state, candidateRepoId, requiredExecutionHostId)
      const worktrees = result.worktrees.filter(
        (worktree) =>
          worktree.id !== worktreeId ||
          !worktreeMatchesHost(worktree, requiredExecutionHostId, matchOptions)
      )
      if (worktrees.length === result.worktrees.length) {
        continue
      }
      if (nextDetectedWorktreesByRepo === state.detectedWorktreesByRepo) {
        nextDetectedWorktreesByRepo = { ...state.detectedWorktreesByRepo }
      }
      nextDetectedWorktreesByRepo[candidateRepoId] = { ...result, worktrees }
    }
    sameIdSurvives =
      resolveSameIdSurvivingHostId(
        {
          ...state,
          worktreesByRepo: nextWorktreesByRepo,
          detectedWorktreesByRepo: nextDetectedWorktreesByRepo
        },
        worktreeId,
        requiredExecutionHostId,
        ignoreWorkspaceCleanupScanSurvivors
      ) !== null || fallbackSurvivingHostId !== null
    const nextDeleteState = { ...state.deleteStateByWorktreeId }
    delete nextDeleteState[composeWorktreeHostIdentity(requiredExecutionHostId, worktreeId)]
    return {
      worktreesByRepo: nextWorktreesByRepo,
      ...(nextDetectedWorktreesByRepo !== state.detectedWorktreesByRepo
        ? { detectedWorktreesByRepo: nextDetectedWorktreesByRepo }
        : {}),
      deleteStateByWorktreeId: nextDeleteState,
      ...(removedActiveHost
        ? {
            activeWorktreeId: survivingHostId ? worktreeId : null,
            activeWorkspaceExecutionHostId: survivingHostId
          }
        : {}),
      sortEpoch: state.sortEpoch + 1
    }
  })
  if (parseExecutionHostId(requiredExecutionHostId)?.kind === 'ssh') {
    rememberAuthoritativelyRemovedWorktrees(requiredExecutionHostId, [worktreeId])
  }
  return sameIdSurvives
}

export function prepareHostScopedRemovalCompletion(
  set: WorktreeSliceSet,
  worktreeId: string,
  requiredExecutionHostId: ExecutionHostId,
  fallbackSurvivingHostId: ExecutionHostId | null,
  ignoreWorkspaceCleanupScanSurvivors = false
): boolean {
  return dropConfirmedHostRow(
    set,
    worktreeId,
    requiredExecutionHostId,
    fallbackSurvivingHostId,
    ignoreWorkspaceCleanupScanSurvivors
  )
}
