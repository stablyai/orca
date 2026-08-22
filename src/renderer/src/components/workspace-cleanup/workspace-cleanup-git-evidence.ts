import type {
  WorkspaceCleanupBlocker,
  WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'
import {
  applyWorkspaceCleanupPolicy,
  WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT
} from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import type {
  WorkspaceCleanupFilterState,
  WorkspaceCleanupSortField,
  WorkspaceCleanupSortState
} from '../../../../shared/workspace-cleanup-filter-model'

/**
 * The host defers git evidence for rows with no inactivity reason, so their
 * `git.checkedAt` is null and the facet layer reads them as `unknown`. A
 * git-dependent filter or sort would then quietly mislabel most of the list,
 * so the dialog re-scans those rows on demand before trusting the answer.
 */
export function hasWorkspaceCleanupGitEvidence(candidate: WorkspaceCleanupCandidate): boolean {
  return candidate.git.checkedAt !== null
}

const GIT_SORT_FIELDS: ReadonlySet<WorkspaceCleanupSortField> = new Set(['git', 'ahead', 'behind'])

const GIT_DERIVED_BLOCKERS: ReadonlySet<WorkspaceCleanupBlocker> = new Set([
  'dirty-files',
  'unpushed-commits',
  'git-status-error',
  'unknown-base'
])

/** Bounds how many worktrees one Git-evidence batch can inspect across a huge fleet. */
export const WORKSPACE_CLEANUP_GIT_EVIDENCE_MAX_TARGETS = WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT

export function needsWorkspaceCleanupGitEvidence(
  filters: WorkspaceCleanupFilterState,
  sort: WorkspaceCleanupSortState
): boolean {
  return (
    filters.git.states.length > 0 ||
    filters.git.minAhead !== null ||
    filters.git.minBehind !== null ||
    filters.safety.blockers.some((blocker) => GIT_DERIVED_BLOCKERS.has(blocker)) ||
    GIT_SORT_FIELDS.has(sort.field)
  )
}

/**
 * Ids still missing git evidence, capped and in list order so the rows the user
 * is looking at resolve first.
 */
export function selectWorkspaceCleanupGitEvidenceTargets(
  candidates: readonly WorkspaceCleanupCandidate[],
  options: {
    resolvedWorktreeIds?: ReadonlySet<string>
    maxTargets?: number
  } = {}
): string[] {
  const resolved = options.resolvedWorktreeIds ?? new Set<string>()
  const max = options.maxTargets ?? WORKSPACE_CLEANUP_GIT_EVIDENCE_MAX_TARGETS
  const targets: string[] = []
  for (const candidate of candidates) {
    if (targets.length >= max) {
      break
    }
    if (!hasWorkspaceCleanupGitEvidence(candidate) && !resolved.has(candidate.worktreeId)) {
      targets.push(candidate.worktreeId)
    }
  }
  return targets
}

/**
 * Focused re-scan results win over the deferred broad-scan row. Keyed by
 * host-qualified identity: applying one host's git state to another host's
 * same-id row would mislabel a dirty workspace as safe to delete (STA-4343).
 */
export function applyWorkspaceCleanupGitEvidence(
  candidates: readonly WorkspaceCleanupCandidate[],
  evidenceByIdentity: ReadonlyMap<string, WorkspaceCleanupCandidate>
): readonly WorkspaceCleanupCandidate[] {
  if (evidenceByIdentity.size === 0) {
    return candidates
  }
  return candidates.map((candidate) => {
    const evidence = evidenceByIdentity.get(getWorkspaceCleanupCandidateIdentity(candidate))
    if (
      evidence === undefined ||
      (candidate.git.checkedAt !== null &&
        candidate.git.checkedAt >= (evidence.git.checkedAt ?? Number.NEGATIVE_INFINITY))
    ) {
      return candidate
    }
    return applyWorkspaceCleanupPolicy({
      ...candidate,
      blockers: [
        ...candidate.blockers.filter((blocker) => !GIT_DERIVED_BLOCKERS.has(blocker)),
        ...evidence.blockers.filter((blocker) => GIT_DERIVED_BLOCKERS.has(blocker))
      ],
      git: evidence.git
    })
  })
}
