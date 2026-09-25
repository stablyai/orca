import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type { WorktreeDeleteState } from '@/store/slices/worktree-helpers'
import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupIdentityWorktreeId,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorkspaceCleanupDeletionPhase } from './workspace-cleanup-candidate-row'

export function getWorkspaceCleanupDeletionPhaseByIdentity(
  candidates: readonly WorkspaceCleanupCandidate[],
  cleanupPhases: Readonly<Record<string, WorkspaceCleanupDeletionPhase>>,
  genericPhasesByDeleteStateKey: Readonly<Record<string, WorkspaceCleanupDeletionPhase>>
): Record<string, WorkspaceCleanupDeletionPhase> {
  const cleanupWorktreeIds = new Set(
    Object.keys(cleanupPhases).map(getWorkspaceCleanupIdentityWorktreeId)
  )
  const phases = { ...cleanupPhases }
  for (const candidate of candidates) {
    if (cleanupWorktreeIds.has(candidate.worktreeId)) {
      continue
    }
    const hostId = resolveWorkspaceCleanupRemovalHostId(candidate)
    const phase =
      (hostId
        ? genericPhasesByDeleteStateKey[composeWorktreeHostIdentity(hostId, candidate.worktreeId)]
        : undefined) ?? genericPhasesByDeleteStateKey[candidate.worktreeId]
    if (phase) {
      phases[getWorkspaceCleanupCandidateIdentity(candidate)] = phase
    }
  }
  return phases
}

/**
 * In-flight delete phases keyed by host-qualified identity.
 *
 * `deleteStateByWorktreeId` is keyed by bare id, so a row whose delete-state
 * names a host is re-keyed onto that host — otherwise two hosts sharing an id
 * would show each other's progress (STA-4343).
 */
export function selectWorkspaceCleanupDeletionPhases(s: {
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState>
}): Record<string, WorkspaceCleanupDeletionPhase> {
  const phases: Record<string, WorkspaceCleanupDeletionPhase> = {}
  for (const [worktreeId, state] of Object.entries(s.deleteStateByWorktreeId)) {
    if (!state.isDeleting) {
      continue
    }
    const executionHostId = state.executionHostId ?? undefined
    const hostPrefix = executionHostId ? composeWorktreeHostIdentity(executionHostId, '') : null
    const key =
      hostPrefix && !worktreeId.startsWith(hostPrefix)
        ? composeWorktreeHostIdentity(executionHostId, worktreeId)
        : worktreeId
    phases[key] = state.phase ?? 'deleting'
  }
  return phases
}
