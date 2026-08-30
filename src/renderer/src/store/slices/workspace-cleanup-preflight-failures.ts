import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  WorkspaceCleanupBlocker,
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanError,
  WorkspaceCleanupUnverifiedRemovalConsent
} from '../../../../shared/workspace-cleanup'
import { shouldForceWorkspaceCleanupRemoval } from '../../../../shared/workspace-cleanup'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import type { WorkspaceCleanupOmissionVerdict } from '../../../../shared/workspace-cleanup-omission-verdict'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupFailure } from './workspace-cleanup'

type PreflightFailureTarget = {
  worktreeId: string
  executionHostId: ExecutionHostId | null
  displayName: string
}

/**
 * The stop for a workspace the rescan did not list, and the row that stop leaves
 * behind. Refusing alone is a dead end: the list keeps showing the picture the
 * user confirmed against, so confirming again re-runs this identical stop —
 * naming the row lets the caller reconcile it away instead.
 *
 * Only an `exited` omission can name one. `unverifiable` means nobody reached the
 * host, and a row retired on that vanishes from the user's list because their
 * connection was down — so it keeps its row and says only what is true.
 *
 * Only a confirmed row can be named. Without one there is no row this stop
 * speaks for, and retiring on the target's id alone would drop a row on evidence
 * gathered about a different host's workspace.
 */
export function getWorkspaceCleanupMissingResult(
  target: PreflightFailureTarget & { approvedCandidate?: WorkspaceCleanupCandidate },
  omissionVerdict: WorkspaceCleanupOmissionVerdict
): { ok: false; failure: WorkspaceCleanupFailure; retiredCandidateIdentity?: string } {
  if (omissionVerdict === 'unverifiable') {
    return { ok: false, failure: getWorkspaceCleanupUnverifiableFailure(target) }
  }
  return {
    ok: false,
    failure: getWorkspaceCleanupMissingFailure(target),
    ...(target.approvedCandidate
      ? {
          retiredCandidateIdentity: getWorkspaceCleanupCandidateIdentity(target.approvedCandidate)
        }
      : {})
  }
}

/** Says only what happened: contact was lost, so nothing was established. */
function getWorkspaceCleanupUnverifiableFailure(
  target: PreflightFailureTarget
): WorkspaceCleanupFailure {
  return {
    worktreeId: target.worktreeId,
    ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
    displayName: target.displayName,
    message: translate(
      'auto.store.slices.workspace.cleanup.listingUnverifiable',
      "Orca couldn't reach this workspace's host to check whether it still exists. Reconnect and try again."
    )
  }
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

/**
 * Why the removal must stop, when the rescan the user never saw changed the
 * picture they confirmed against. `null` when nothing new appeared — a verdict
 * the confirmed row already carried is still covered by that consent.
 *
 * Each message states the verdict the preflight holds now. A verdict absent from
 * the approved snapshot need not have *arisen* after the confirmation — that
 * snapshot may simply never have observed it — so no message claims it did.
 */
export function getWorkspaceCleanupPostConfirmationMessage(
  candidate: WorkspaceCleanupCandidate,
  approvedCandidate: WorkspaceCleanupCandidate
): string | null {
  const added = (blocker: WorkspaceCleanupBlocker): boolean =>
    candidate.blockers.includes(blocker) && !approvedCandidate.blockers.includes(blocker)
  if (
    (shouldForceWorkspaceCleanupRemoval(candidate) &&
      !shouldForceWorkspaceCleanupRemoval(approvedCandidate)) ||
    WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS.some(added)
  ) {
    return translate(
      'auto.store.slices.workspace.cleanup.changedSinceConfirmation',
      'Workspace changed after confirmation. Refresh to review it before removing.'
    )
  }
  return (
    WORKSPACE_CLEANUP_POST_CONFIRMATION_VERDICTS.find(({ blockers }) =>
      blockers.some(added)
    )?.getMessage() ?? null
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

/**
 * Verdicts that invalidate a confirmation, kept apart from the risk blockers
 * above and from each other because each claims something different:
 * `dirty-editor-buffer` is positive evidence of work that deleting would
 * destroy, `running-terminal` and `live-agent` are positive evidence that work
 * is live, and `terminal-liveness-unknown` is the loss of contact that proves
 * nothing either way — so only the middle entry may be reported as running.
 *
 * Ordered by what the user would most regret: unsaved editor text is the only
 * one of these that cannot be recreated once the worktree is deleted. A
 * terminal can be restarted; a buffer that was never written to disk cannot.
 */
const WORKSPACE_CLEANUP_POST_CONFIRMATION_VERDICTS: readonly {
  blockers: readonly WorkspaceCleanupBlocker[]
  getMessage: () => string
}[] = [
  {
    blockers: ['dirty-editor-buffer'],
    getMessage: () =>
      translate(
        'auto.store.slices.workspace.cleanup.unsavedEditorSinceConfirmation',
        'This workspace has unsaved editor changes that deleting it would discard permanently. Review it before removing.'
      )
  },
  {
    blockers: ['running-terminal', 'live-agent'],
    getMessage: () =>
      translate(
        'auto.store.slices.workspace.cleanup.liveWorkSinceConfirmation',
        'A terminal or agent in this workspace is running. Review it before removing.'
      )
  },
  {
    // Blocks without proving risk: the confirm screen names this verdict, so a
    // row confirmed while its terminal read idle was authorized on evidence the
    // preflight no longer has. Deleting anyway spends consent never given.
    blockers: ['terminal-liveness-unknown'],
    getMessage: () =>
      translate(
        'auto.store.slices.workspace.cleanup.livenessUnverifiableSinceConfirmation',
        "Orca cannot verify this workspace's terminals. Review it before removing."
      )
  }
]
