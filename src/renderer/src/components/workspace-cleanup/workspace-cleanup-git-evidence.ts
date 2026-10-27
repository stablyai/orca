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

/** Broad scans may defer Git reads; resolve unknown rows on demand before trusting Git-based filtering or sorting. */
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

/** Cap missing-evidence IDs in list order so visible rows resolve first. */
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

/** Targeted evidence overrides broad-scan unknowns by host-qualified identity, never another host’s same-ID row (STA-4343). */
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
