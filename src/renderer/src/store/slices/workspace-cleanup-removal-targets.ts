/**
 * Host-qualified removal identity for workspace cleanup (STA-4343).
 *
 * A cleanup row's `worktreeId` is `repoId::path`, which two execution hosts can
 * both own. Selection, confirmation, preflight and removal therefore travel as
 * a (worktreeId, executionHostId) pair. Where the owner cannot be pinned — an
 * id-only row that the store knows on several hosts, a confirmation naming two
 * hosts at once, or a refreshed scan that no longer shows the row on the
 * confirmed host — the target resolves to a failure instead of a best guess:
 * deleting the wrong host's workspace destroys uncommitted work.
 */
import type { AppState } from '../types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  canQueueWorkspaceCleanupCandidate,
  shouldForceWorkspaceCleanupRemoval,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupScanError,
  type WorkspaceCleanupUnverifiedRemovalConsent
} from '../../../../shared/workspace-cleanup'
import {
  resolveWorkspaceCleanupOmissionVerdict,
  type WorkspaceCleanupRepoListing
} from '../../../../shared/workspace-cleanup-omission-verdict'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'
import { getWorktreeOperationOwnerHostIds } from '@/lib/worktree-operation-route'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupFailure } from './workspace-cleanup'
import {
  getWorkspaceCleanupGitUnavailableFailure,
  getWorkspaceCleanupMissingFailure,
  getWorkspaceCleanupMissingResult,
  getWorkspaceCleanupPostConfirmationMessage,
  getWorkspaceCleanupRepoScanFailure,
  hasValidWorkspaceCleanupUnverifiedConsent
} from './workspace-cleanup-preflight-failures'

/** Everything the preflight's rescan reported besides the candidate rows. */
export type WorkspaceCleanupPreflightScanReport = {
  errors?: readonly WorkspaceCleanupScanError[]
  repoListings?: readonly WorkspaceCleanupRepoListing[]
}

/** Distinct from every ExecutionHostId, so a hostless row cannot alias one. */
const UNQUALIFIED_HOST_BUCKET = Symbol('unqualified-cleanup-host')

export type WorkspaceCleanupRemovalTarget = {
  kind: 'target'
  worktreeId: string
  /**
   * The host the user confirmed. Null is reserved for legacy internal callers
   * that did not supply confirmation candidates.
   */
  executionHostId: ExecutionHostId | null
  displayName: string
  approvedCandidate?: WorkspaceCleanupCandidate
}

export type WorkspaceCleanupUnresolvedTarget = {
  kind: 'unresolved'
  failure: WorkspaceCleanupFailure
}

export type WorkspaceCleanupRemovalTargetResolution =
  | WorkspaceCleanupRemovalTarget
  | WorkspaceCleanupUnresolvedTarget

export type WorkspaceCleanupPreflightResult =
  | {
      ok: true
      target: WorkspaceCleanupRemovalTarget
      candidate: WorkspaceCleanupCandidate
      sameIdSurvivingHostId?: ExecutionHostId
    }
  | {
      ok: false
      failure: WorkspaceCleanupFailure
      /**
       * The rescanned row the verdict was read off. The preflight is the only
       * place it exists, so a caller that stops here must publish it or the
       * user keeps confirming against the picture that was already refused.
       */
      refreshedCandidate?: WorkspaceCleanupCandidate
      /**
       * The confirmed row the rescan no longer lists at all, so there is no
       * refreshed row to publish in its place — the reconciliation is to drop
       * it. Only set when the scan actually answered for this workspace: a scan
       * that failed already returns above, and a host that is merely out of
       * contact still publishes its rows as blocked rather than omitting them.
       */
      retiredCandidateIdentity?: string
    }

type WorkspaceCleanupRemovalTargetState = Pick<
  AppState,
  'worktreesByRepo' | 'detectedWorktreesByRepo'
>

function ambiguousHostFailure(
  worktreeId: string,
  displayName: string
): WorkspaceCleanupUnresolvedTarget {
  return {
    kind: 'unresolved',
    failure: {
      worktreeId,
      displayName,
      message: translate(
        'auto.store.slices.workspace.cleanup.hostUnresolved',
        'Orca cannot tell which host owns this workspace. Refresh projects and review it again.'
      )
    }
  }
}

export function resolveWorkspaceCleanupRemovalTargets(
  worktreeIds: readonly string[],
  state: WorkspaceCleanupRemovalTargetState,
  options: { approvedCandidates?: readonly WorkspaceCleanupCandidate[] } = {}
): WorkspaceCleanupRemovalTargetResolution[] {
  const requestedCountByWorktreeId = new Map<string, number>()
  for (const worktreeId of worktreeIds) {
    requestedCountByWorktreeId.set(
      worktreeId,
      (requestedCountByWorktreeId.get(worktreeId) ?? 0) + 1
    )
  }
  const approvedByWorktreeId = new Map<string, WorkspaceCleanupCandidate[]>()
  for (const candidate of options.approvedCandidates ?? []) {
    const approved = approvedByWorktreeId.get(candidate.worktreeId) ?? []
    approved.push(candidate)
    approvedByWorktreeId.set(candidate.worktreeId, approved)
  }

  const approvedCursorByWorktreeId = new Map<string, number>()
  return worktreeIds.map((worktreeId) => {
    const approved = approvedByWorktreeId.get(worktreeId) ?? []
    const cursor = approvedCursorByWorktreeId.get(worktreeId) ?? 0
    approvedCursorByWorktreeId.set(worktreeId, cursor + 1)
    const requestedEveryApprovedRow = requestedCountByWorktreeId.get(worktreeId) === approved.length
    const confirmedCandidate = approved.length > 1 ? approved[cursor] : approved[0]
    const displayName = confirmedCandidate?.displayName ?? approved[0]?.displayName ?? worktreeId
    // Why: one id with two confirmed hosts is ambiguous unless the caller also
    // supplies two id occurrences, one for each explicitly approved row.
    //
    // Why the STRICT resolver: the display identity defaults a hostless row to
    // `local`, so a hostless row and a genuine local row for the same id share an
    // identity and this gate would not fire. Destructive code may not guess a
    // host — an unqualified row is its own bucket here.
    if (
      !requestedEveryApprovedRow &&
      new Set(
        approved.map(
          (candidate) => resolveWorkspaceCleanupRemovalHostId(candidate) ?? UNQUALIFIED_HOST_BUCKET
        )
      ).size > 1
    ) {
      return ambiguousHostFailure(worktreeId, displayName)
    }
    const confirmedHostId = confirmedCandidate
      ? resolveWorkspaceCleanupRemovalHostId(confirmedCandidate)
      : null
    if (confirmedCandidate && confirmedHostId) {
      return {
        kind: 'target',
        worktreeId,
        executionHostId: confirmedHostId,
        displayName,
        approvedCandidate: confirmedCandidate
      }
    }
    // A displayed row without host evidence cannot prove where the user
    // intended to delete, even if the current catalog happens to list one owner.
    if (confirmedCandidate) {
      return ambiguousHostFailure(worktreeId, displayName)
    }
    // No host evidence on the row: accept it only while the store itself knows
    // a single owner. This compatibility path is reachable only by internal
    // callers that did not provide a confirmed candidate.
    const ownerHostIds = getWorktreeOperationOwnerHostIds(state, worktreeId)
    if (ownerHostIds.length > 1) {
      return ambiguousHostFailure(worktreeId, displayName)
    }
    return {
      kind: 'target',
      worktreeId,
      executionHostId: ownerHostIds[0] ?? null,
      displayName,
      ...(confirmedCandidate ? { approvedCandidate: confirmedCandidate } : {})
    }
  })
}

function resolvePreflightCandidate(
  target: WorkspaceCleanupRemovalTarget,
  candidatesByIdentity: ReadonlyMap<string, WorkspaceCleanupCandidate>,
  identitiesByWorktreeId: ReadonlyMap<string, ReadonlySet<string>>
): { ok: true; candidate: WorkspaceCleanupCandidate | undefined } | { ok: false } {
  const identities = identitiesByWorktreeId.get(target.worktreeId)
  if (target.executionHostId) {
    // Why: the refreshed row must be the SAME host's row. Another host's
    // evidence would decide force/blockers for a workspace it does not own.
    return {
      ok: true,
      candidate: candidatesByIdentity.get(
        getWorkspaceCleanupHostIdentity(target.executionHostId, target.worktreeId)
      )
    }
  }
  // An unqualified target can only proceed while the rescan agrees there is one owner.
  if ((identities?.size ?? 0) > 1) {
    return { ok: false }
  }
  const identity = identities?.values().next().value
  return {
    ok: true,
    candidate: identity ? candidatesByIdentity.get(identity) : undefined
  }
}

export function evaluateWorkspaceCleanupPreflight(
  target: WorkspaceCleanupRemovalTarget,
  candidatesByIdentity: ReadonlyMap<string, WorkspaceCleanupCandidate>,
  identitiesByWorktreeId: ReadonlyMap<string, ReadonlySet<string>>,
  scanReport: WorkspaceCleanupPreflightScanReport = {},
  options: {
    unverifiedRemovalConsent?: WorkspaceCleanupUnverifiedRemovalConsent
    getConsentAttemptId?: (identity: string) => string | undefined
  } = {}
): WorkspaceCleanupPreflightResult {
  const resolved = resolvePreflightCandidate(target, candidatesByIdentity, identitiesByWorktreeId)
  if (!resolved.ok) {
    return {
      ok: false,
      failure: ambiguousHostFailure(target.worktreeId, target.displayName).failure
    }
  }
  const repoScanFailure = getWorkspaceCleanupRepoScanFailure(target, scanReport.errors ?? [])
  const consentReference = resolved.candidate ?? target.approvedCandidate
  const hasUnverifiedRemovalConsent = hasValidWorkspaceCleanupUnverifiedConsent(
    consentReference ? getWorkspaceCleanupCandidateIdentity(consentReference) : '',
    options.unverifiedRemovalConsent,
    options.getConsentAttemptId
  )
  if (repoScanFailure && !hasUnverifiedRemovalConsent) {
    return {
      ok: false,
      failure: repoScanFailure,
      ...(resolved.candidate ? { refreshedCandidate: resolved.candidate } : {})
    }
  }
  const candidate =
    resolved.candidate ??
    (repoScanFailure && hasUnverifiedRemovalConsent ? target.approvedCandidate : undefined)
  if (!candidate) {
    // Why a verdict and not just "absent": the same empty answer arrives from a
    // host that listed its workspaces without this one and from a host nobody
    // reached. Only the first is grounds to retire the user's row.
    return getWorkspaceCleanupMissingResult(
      target,
      resolveWorkspaceCleanupOmissionVerdict(
        {
          repoId: getRepoIdFromWorktreeId(target.worktreeId),
          executionHostId: target.executionHostId
        },
        scanReport.repoListings
      )
    )
  }
  const stop = (failure: WorkspaceCleanupFailure): WorkspaceCleanupPreflightResult => ({
    ok: false,
    refreshedCandidate: candidate,
    failure
  })
  const failure = (message: string): WorkspaceCleanupPreflightResult =>
    stop({
      worktreeId: target.worktreeId,
      ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
      displayName: candidate.displayName,
      message
    })
  if (!canQueueWorkspaceCleanupCandidate(candidate)) {
    return failure(
      candidate.blockers.length
        ? candidate.blockers.join(', ')
        : 'Workspace needs another look before removal.'
    )
  }
  const candidateIdentity = getWorkspaceCleanupCandidateIdentity(candidate)
  if (
    target.approvedCandidate &&
    candidateIdentity !== getWorkspaceCleanupCandidateIdentity(target.approvedCandidate)
  ) {
    return stop(getWorkspaceCleanupMissingFailure(target))
  }
  if (candidate.blockers.includes('git-status-error') && !hasUnverifiedRemovalConsent) {
    return stop(getWorkspaceCleanupGitUnavailableFailure(target, candidate))
  }
  if (!target.approvedCandidate && shouldForceWorkspaceCleanupRemoval(candidate)) {
    return failure(
      translate(
        'auto.store.slices.workspace.cleanup.forceNeedsApproval',
        'Review and confirm this workspace before force deleting it.'
      )
    )
  }
  // This rescan also re-probes terminals; any verdict it adds post-confirmation
  // was never shown to the user, so deleting on it would delete without consent.
  const changedSinceConfirmation = target.approvedCandidate
    ? getWorkspaceCleanupPostConfirmationMessage(candidate, target.approvedCandidate)
    : null
  if (changedSinceConfirmation) {
    return failure(changedSinceConfirmation)
  }
  const sameIdSurvivingHostId = [...(identitiesByWorktreeId.get(target.worktreeId) ?? [])]
    .filter((identity) => identity !== candidateIdentity)
    .map((identity) => candidatesByIdentity.get(identity))
    .map((otherCandidate) =>
      otherCandidate ? resolveWorkspaceCleanupRemovalHostId(otherCandidate) : null
    )
    .find((hostId) => hostId !== null)
  return {
    ok: true,
    target,
    candidate,
    ...(sameIdSurvivingHostId ? { sameIdSurvivingHostId } : {})
  }
}
