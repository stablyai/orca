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
  WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'
import { getWorktreeOperationOwnerHostIds } from '@/lib/worktree-operation-route'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupFailure } from './workspace-cleanup'

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
  | { ok: false; failure: WorkspaceCleanupFailure }

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

export async function preflightWorkspaceCleanupCandidates(
  targets: readonly WorkspaceCleanupRemovalTarget[],
  getState: () => AppState,
  enrich: (
    candidates: readonly WorkspaceCleanupCandidate[],
    state: AppState
  ) => Promise<WorkspaceCleanupCandidate[]>
): Promise<WorkspaceCleanupPreflightResult[]> {
  // Why: one batched scan per chunk replaces a git worktree-list + activity
  // read per row; chunks stay under main's silent target truncation limit.
  const candidatesByIdentity = new Map<string, WorkspaceCleanupCandidate>()
  const identitiesByWorktreeId = new Map<string, Set<string>>()
  const worktreeIds = targets.map((target) => target.worktreeId)
  for (let start = 0; start < worktreeIds.length; start += WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT) {
    const chunk = worktreeIds.slice(start, start + WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT)
    const scan = await window.api.workspaceCleanup.scan({
      worktreeIds: [...chunk],
      scanId: crypto.randomUUID(),
      refreshActivity: true
    })
    const enriched = await enrich(scan.candidates, getState())
    for (const candidate of enriched) {
      const identity = getWorkspaceCleanupCandidateIdentity(candidate)
      candidatesByIdentity.set(identity, candidate)
      const identities = identitiesByWorktreeId.get(candidate.worktreeId) ?? new Set<string>()
      identities.add(identity)
      identitiesByWorktreeId.set(candidate.worktreeId, identities)
    }
  }
  return targets.map((target) =>
    evaluateWorkspaceCleanupPreflight(target, candidatesByIdentity, identitiesByWorktreeId)
  )
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
  return { ok: true, candidate: identity ? candidatesByIdentity.get(identity) : undefined }
}

export function evaluateWorkspaceCleanupPreflight(
  target: WorkspaceCleanupRemovalTarget,
  candidatesByIdentity: ReadonlyMap<string, WorkspaceCleanupCandidate>,
  identitiesByWorktreeId: ReadonlyMap<string, ReadonlySet<string>>
): WorkspaceCleanupPreflightResult {
  const resolved = resolvePreflightCandidate(target, candidatesByIdentity, identitiesByWorktreeId)
  if (!resolved.ok) {
    return {
      ok: false,
      failure: ambiguousHostFailure(target.worktreeId, target.displayName).failure
    }
  }
  const candidate = resolved.candidate
  if (!candidate) {
    return {
      ok: false,
      failure: {
        worktreeId: target.worktreeId,
        ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
        displayName: target.displayName,
        message: translate(
          'auto.store.slices.workspace.cleanup.9d6e531da6',
          'Workspace no longer exists.'
        )
      }
    }
  }
  const failure = (message: string): WorkspaceCleanupPreflightResult => ({
    ok: false,
    failure: {
      worktreeId: target.worktreeId,
      ...(target.executionHostId ? { executionHostId: target.executionHostId } : {}),
      displayName: candidate.displayName,
      message
    }
  })
  if (!canQueueWorkspaceCleanupCandidate(candidate)) {
    return failure(
      candidate.blockers.length
        ? candidate.blockers.join(', ')
        : 'Workspace needs another look before removal.'
    )
  }
  // Why: this row may be removed minutes after the confirm click. If it now
  // needs a force removal the user never approved (new dirt, unpushed work,
  // or a git error since confirmation), fail it instead of force-deleting.
  const approvedCandidate = target.approvedCandidate
  if (approvedCandidate) {
    const escalatedToForce =
      shouldForceWorkspaceCleanupRemoval(candidate) &&
      !shouldForceWorkspaceCleanupRemoval(approvedCandidate)
    // Why: an approved row that was already force-flagged for an unverifiable
    // reason must still fail when real dirt/unpushed work is now visible.
    const revealedConcreteRisk = WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS.some(
      (blocker) =>
        candidate.blockers.includes(blocker) && !approvedCandidate.blockers.includes(blocker)
    )
    if (escalatedToForce || revealedConcreteRisk) {
      return failure(
        translate(
          'auto.store.slices.workspace.cleanup.changedSinceConfirmation',
          'Workspace changed after confirmation. Refresh to review it before removing.'
        )
      )
    }
  }
  const removedIdentity = getWorkspaceCleanupCandidateIdentity(candidate)
  const sameIdSurvivingHostId = [...(identitiesByWorktreeId.get(target.worktreeId) ?? [])]
    .filter((identity) => identity !== removedIdentity)
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

// Why: dirty-files/unpushed-commits are concrete known work at risk; unknown-base
// and git-status-error only mean "couldn't verify". A row approved while
// unverifiable must still fail if real work becomes visible before removal.
const WORKSPACE_CLEANUP_CONCRETE_RISK_BLOCKERS = ['dirty-files', 'unpushed-commits'] as const
