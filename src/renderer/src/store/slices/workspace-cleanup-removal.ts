import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupDismissal,
  WorkspaceCleanupUnverifiedRemovalConsent
} from '../../../../shared/workspace-cleanup'
import { shouldForceWorkspaceCleanupRemoval } from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity
} from '../../../../shared/workspace-cleanup-host-identity'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'
import {
  preflightWorkspaceCleanupCandidates,
  resolveWorkspaceCleanupRemovalTargets,
  type WorkspaceCleanupRemovalTarget
} from './workspace-cleanup-removal-targets'
import { enrichWorkspaceCleanupCandidates } from './workspace-cleanup-candidate-enrichment'
import { invalidateWorkspaceCleanupScanProgress } from './workspace-cleanup-scan-progress'

export type WorkspaceCleanupFailure = {
  worktreeId: string
  executionHostId?: ExecutionHostId
  displayName: string
  message: string
  canDeleteAnyway?: boolean
}
export type WorkspaceCleanupRemoveResult = {
  removedIds: string[]
  removedIdentities: string[]
  failures: WorkspaceCleanupFailure[]
  preservedBranches?: PreservedBranchCleanup[]
}
export type WorkspaceCleanupRemoveOptions = {
  approvedCandidates?: readonly WorkspaceCleanupCandidate[]
  snapshotPruneBatchId?: string
  unverifiedRemovalConsent?: WorkspaceCleanupUnverifiedRemovalConsent
  getConsentAttemptId?: (identity: string) => string | undefined
}

export async function removeWorkspaceCleanupCandidates(
  get: () => AppState,
  set: (
    partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
    replace?: false
  ) => void,
  worktreeIds: readonly string[],
  options?: WorkspaceCleanupRemoveOptions
): Promise<WorkspaceCleanupRemoveResult> {
  const removedIds: string[] = []
  const removedIdentities = new Set<string>()
  const failures: WorkspaceCleanupFailure[] = []
  const preservedBranches: PreservedBranchCleanup[] = []

  // Why (STA-4343): the confirmed row — not the id — names the host to delete
  // on. Everything below carries that owner so nothing re-derives it from the
  // active workspace, which owns the same `repoId::path` id on another host.
  const targets = resolveWorkspaceCleanupRemovalTargets(
    worktreeIds,
    get(),
    options?.approvedCandidates ? { approvedCandidates: options.approvedCandidates } : {}
  )
  const removableTargets: WorkspaceCleanupRemovalTarget[] = []
  for (const target of targets) {
    if (target.kind === 'unresolved') {
      failures.push(target.failure)
      continue
    }
    removableTargets.push(target)
  }

  const preflights = await preflightWorkspaceCleanupCandidates(
    removableTargets,
    get,
    (candidates, state) =>
      enrichWorkspaceCleanupCandidates(candidates, state, { applyDismissals: false }),
    {
      unverifiedRemovalConsent: options?.unverifiedRemovalConsent,
      getConsentAttemptId: options?.getConsentAttemptId
    }
  )
  const targetsToRemove: {
    target: WorkspaceCleanupRemovalTarget
    candidate: WorkspaceCleanupCandidate
    sameIdSurvivingHostId?: ExecutionHostId
    ignoreWorkspaceCleanupScanSurvivors?: boolean
  }[] = []

  for (const preflight of preflights) {
    if (!preflight.ok) {
      failures.push(preflight.failure)
      continue
    }
    targetsToRemove.push({
      target: preflight.target,
      candidate: preflight.candidate,
      ...(preflight.sameIdSurvivingHostId
        ? { sameIdSurvivingHostId: preflight.sameIdSurvivingHostId }
        : {})
    })
  }
  const scheduledRemovalIdentities = new Set(
    targetsToRemove.map(({ candidate }) => getWorkspaceCleanupCandidateIdentity(candidate))
  )
  for (const pendingRemoval of targetsToRemove) {
    if (
      pendingRemoval.sameIdSurvivingHostId &&
      scheduledRemovalIdentities.has(
        getWorkspaceCleanupHostIdentity(
          pendingRemoval.sameIdSurvivingHostId,
          pendingRemoval.candidate.worktreeId
        )
      )
    ) {
      delete pendingRemoval.sameIdSurvivingHostId
      pendingRemoval.ignoreWorkspaceCleanupScanSurvivors = true
    }
  }

  // Why: nested workspaces can belong to different repos; parent removal must
  // not race child cleanup hooks, PTY teardown, or metadata deletion.
  for (const { target, candidate, sameIdSurvivingHostId, ignoreWorkspaceCleanupScanSurvivors } of [
    ...targetsToRemove
  ].sort((a, b) => b.candidate.path.length - a.candidate.path.length)) {
    const result = await get().removeWorktree(
      // The resolved target names the host whose row the user confirmed; the
      // removal is routed there instead of to the active workspace's host.
      { id: candidate.worktreeId, executionHostId: target.executionHostId },
      shouldForceWorkspaceCleanupRemoval(candidate),
      // Why: cleanup reports outcomes in its own summary toasts; per-row
      // preserved-branch warnings would stack one toast per removed row.
      {
        suppressPreservedBranchToast: true,
        ...(sameIdSurvivingHostId ? { sameIdSurvivingHostId } : {}),
        ...(ignoreWorkspaceCleanupScanSurvivors
          ? { ignoreWorkspaceCleanupScanSurvivors: true }
          : {}),
        ...(options?.snapshotPruneBatchId
          ? { snapshotPruneBatchId: options.snapshotPruneBatchId }
          : {})
      }
    )
    if (result.ok) {
      removedIds.push(candidate.worktreeId)
      removedIdentities.add(getWorkspaceCleanupCandidateIdentity(candidate))
      if (result.preservedBranch) {
        preservedBranches.push({
          worktreeId: candidate.worktreeId,
          branchName: result.preservedBranch.branchName,
          expectedHead: result.preservedBranch.head,
          ...(result.preservedBranch.hostId ? { hostId: result.preservedBranch.hostId } : {}),
          ...(result.preservedBranch.runtimeEnvironmentId
            ? { runtimeEnvironmentId: result.preservedBranch.runtimeEnvironmentId }
            : {})
        })
      }
    } else {
      failures.push({
        worktreeId: candidate.worktreeId,
        ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
        displayName: candidate.displayName,
        message: result.error
      })
    }
  }

  if (removedIds.length > 0) {
    invalidateWorkspaceCleanupScanProgress()
    let prunableWorktreeIds = new Set(removedIds)
    set((state) => {
      const remainingCandidates = state.workspaceCleanupScan?.candidates.filter(
        (candidate) => !removedIdentities.has(getWorkspaceCleanupCandidateIdentity(candidate))
      )
      // Why: a same-id row on another host survives this removal, and its
      // dismissal/viewed marks are keyed by worktree id alone — dropping them
      // would resurrect a row the user already ignored.
      const survivingWorktreeIds = new Set(
        (remainingCandidates ?? []).map((candidate) => candidate.worktreeId)
      )
      prunableWorktreeIds = new Set(
        removedIds.filter((worktreeId) => !survivingWorktreeIds.has(worktreeId))
      )
      return {
        workspaceCleanupLoading: false,
        workspaceCleanupScan:
          state.workspaceCleanupScan && remainingCandidates
            ? { ...state.workspaceCleanupScan, candidates: remainingCandidates }
            : state.workspaceCleanupScan,
        // Why: dismissals and viewed marks for removed worktrees are dead
        // weight in the store and in every persisted-dismissals write.
        workspaceCleanupDismissals: pruneWorkspaceCleanupDismissals(
          state.workspaceCleanupDismissals,
          prunableWorktreeIds
        ),
        workspaceCleanupViewedCandidates: pruneWorkspaceCleanupRecord(
          state.workspaceCleanupViewedCandidates,
          prunableWorktreeIds
        )
      }
    })
    if (prunableWorktreeIds.size > 0) {
      void window.api.workspaceCleanup
        .dismiss({ dismissals: [], removedWorktreeIds: [...prunableWorktreeIds] })
        .catch((error: unknown) => {
          console.warn('Failed to prune persisted cleanup dismissals', error)
        })
    }
  }

  return {
    removedIds,
    removedIdentities: [...removedIdentities],
    failures,
    ...(preservedBranches.length > 0 ? { preservedBranches } : {})
  }
}

function pruneWorkspaceCleanupDismissals(
  dismissals: Record<string, WorkspaceCleanupDismissal>,
  removedIds: ReadonlySet<string>
): Record<string, WorkspaceCleanupDismissal> {
  if (!Object.values(dismissals).some((dismissal) => removedIds.has(dismissal.worktreeId))) {
    return dismissals
  }
  return Object.fromEntries(
    Object.entries(dismissals).filter(([, dismissal]) => !removedIds.has(dismissal.worktreeId))
  )
}

function pruneWorkspaceCleanupRecord<T>(
  record: Record<string, T>,
  removedIds: ReadonlySet<string>
) {
  if (!Object.keys(record).some((id) => removedIds.has(id))) {
    return record
  }
  return Object.fromEntries(Object.entries(record).filter(([id]) => !removedIds.has(id)))
}
