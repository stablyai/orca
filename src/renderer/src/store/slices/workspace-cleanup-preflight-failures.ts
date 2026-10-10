import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanError,
  WorkspaceCleanupUnverifiedRemovalConsent
} from '../../../../shared/workspace-cleanup'
import { shouldForceWorkspaceCleanupRemoval } from '../../../../shared/workspace-cleanup'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupFailure } from './workspace-cleanup'

type PreflightFailureTarget = {
  worktreeId: string
  executionHostId: ExecutionHostId | null
  displayName: string
}

export function getWorkspaceCleanupMissingFailure(
  target: PreflightFailureTarget
): WorkspaceCleanupFailure {
  return {
    worktreeId: target.worktreeId,
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
    displayName: target.displayName,
    message: translate(
      'auto.store.slices.workspace.cleanup.9d6e531da6',
      'Workspace no longer exists.'
    )
  }
}

export function hasWorkspaceCleanupRiskEscalated(
  candidate: WorkspaceCleanupCandidate,
  approvedCandidate: WorkspaceCleanupCandidate
): boolean {
  return (
    (shouldForceWorkspaceCleanupRemoval(candidate) &&
      !shouldForceWorkspaceCleanupRemoval(approvedCandidate)) ||
    WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS.some(
      (blocker) =>
        candidate.blockers.includes(blocker) && !approvedCandidate.blockers.includes(blocker)
    )
  )
}

export function hasValidWorkspaceCleanupUnverifiedConsent(
  candidateIdentity: string,
  consent: WorkspaceCleanupUnverifiedRemovalConsent | undefined,
  getConsentAttemptId: ((identity: string) => string | undefined) | undefined
): boolean {
  return Boolean(
    consent &&
    consent.identity === candidateIdentity &&
    getConsentAttemptId?.(consent.identity) === consent.attemptId
  )
}

export function getWorkspaceCleanupRepoScanFailure(
  target: PreflightFailureTarget,
  errors: readonly WorkspaceCleanupScanError[]
): WorkspaceCleanupFailure | null {
  const error = errors.find(
    (entry) =>
      entry.repoId === getRepoIdFromWorktreeId(target.worktreeId) &&
      (!entry.executionHostId ||
        target.executionHostId === null ||
        entry.executionHostId === target.executionHostId)
  )
  if (!error) {
    return null
  }
  return {
    worktreeId: target.worktreeId,
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
    displayName: target.displayName,
    message: error.executionHostId
      ? translate(
          'auto.store.slices.workspace.cleanup.gitStatusUnavailable',
          "Orca couldn't check this workspace's git status. Try again, or delete it from its host-specific sidebar or project list."
        )
      : translate(
          'auto.store.slices.workspace.cleanup.gitStatusUnavailableOlderPeer',
          "Orca couldn't match this git-status failure to a host. Update the older connected peer, or delete the workspace from its host-specific sidebar or project list."
        ),
    canDeleteAnyway: true
  }
}

export function getWorkspaceCleanupGitUnavailableFailure(
  target: PreflightFailureTarget,
  candidate: WorkspaceCleanupCandidate
): WorkspaceCleanupFailure {
  return {
    worktreeId: target.worktreeId,
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
    displayName: candidate.displayName,
    message: translate(
      'auto.store.slices.workspace.cleanup.gitStatusUnavailable',
      "Orca couldn't check this workspace's git status. Try again, or delete it from its host-specific sidebar or project list."
    ),
    canDeleteAnyway: true
  }
}

// Unlike unknown-base and git-status-error, these facts prove known work is at risk.
const WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS = ['dirty-files', 'unpushed-commits'] as const
