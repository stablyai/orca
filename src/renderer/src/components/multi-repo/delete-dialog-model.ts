import type {
  MultiRepoDeleteInspection,
  MultiRepoDeleteMemberInspection,
  MultiRepoDeleteResult
} from '../../../../shared/multi-repo-workspace'

export type DeleteRowPhase = 'idle' | 'removing' | 'removed' | 'failed'

export type DeleteRow = {
  memberId: string
  label: string
  branchName: string
  /** Null means the check could not run, never "clean". */
  dirtyCount: number | null
  unpublishedCommitCount: number | null
  /** Uncommitted or unpublished work: removal needs the repo's own consent. */
  risky: boolean
  /** The worktree is already gone; removal only forgets metadata. */
  worktreeGone: boolean
  /** Branch survives removal because it has unmerged commits; null when that could not be checked. */
  branchKept: boolean | null
  phase: DeleteRowPhase
  failureMessage: string | null
  preservedBranch: string | null
}

export type DeleteMemberLabels = ReadonlyMap<string, { label: string; branchName: string }>

export function buildDeleteRows(
  inspection: MultiRepoDeleteInspection,
  labels: DeleteMemberLabels
): DeleteRow[] {
  const rows = inspection.members.map((member) => toRow(member, labels))
  // Risky rows first, so the repos that need a decision are never below the fold.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => Number(b.row.risky) - Number(a.row.risky) || a.index - b.index)
    .map(({ row }) => row)
}

function toRow(member: MultiRepoDeleteMemberInspection, labels: DeleteMemberLabels): DeleteRow {
  const known = labels.get(member.memberId)
  return {
    memberId: member.memberId,
    label: known?.label ?? member.repoId,
    branchName: known?.branchName ?? '',
    dirtyCount: member.dirtyCount,
    unpublishedCommitCount: member.unpublishedCommitCount,
    risky:
      member.dirtyCount === null ||
      member.dirtyCount > 0 ||
      member.unpublishedCommitCount === null ||
      member.unpublishedCommitCount > 0,
    worktreeGone: !member.worktreeExists,
    branchKept: member.willKeepBranch,
    phase: 'idle',
    failureMessage: null,
    preservedBranch: null
  }
}

export function toggleForceMember(forced: ReadonlySet<string>, memberId: string): Set<string> {
  const next = new Set(forced)
  if (!next.delete(memberId)) {
    next.add(memberId)
  }
  return next
}

/** Only repos that still hold a worktree and were ticked are sent as forced. */
export function getForcedMemberIds(
  rows: readonly DeleteRow[],
  forced: ReadonlySet<string>
): string[] {
  return rows
    .filter((row) => row.risky && row.phase !== 'removed' && forced.has(row.memberId))
    .map((row) => row.memberId)
}

export function markRemoving(rows: readonly DeleteRow[]): DeleteRow[] {
  return rows.map((row) =>
    row.phase === 'removed' ? row : { ...row, phase: 'removing', failureMessage: null }
  )
}

/** Merge the host's per-repo outcomes; a repo that was removed is never touched again. */
export function applyDeleteResult(
  rows: readonly DeleteRow[],
  result: MultiRepoDeleteResult
): DeleteRow[] {
  const outcomes = new Map(result.members.map((outcome) => [outcome.memberId, outcome]))
  return rows.map((row) => {
    const outcome = outcomes.get(row.memberId)
    if (!outcome) {
      // The host no longer lists the repo: it was removed by an earlier attempt.
      return row.phase === 'removing' ? { ...row, phase: 'removed' } : row
    }
    if (outcome.status === 'failed') {
      return { ...row, phase: 'failed', failureMessage: outcome.message }
    }
    return {
      ...row,
      phase: 'removed',
      failureMessage: null,
      preservedBranch: outcome.status === 'removed' ? (outcome.preservedBranch ?? null) : null
    }
  })
}

export function countFailed(rows: readonly DeleteRow[]): number {
  return rows.filter((row) => row.phase === 'failed').length
}

export function countRemaining(rows: readonly DeleteRow[]): number {
  return rows.filter((row) => row.phase !== 'removed').length
}

/** Enter confirms only a clean workspace; a risky one needs a deliberate click. */
export function enterConfirmsDelete(rows: readonly DeleteRow[]): boolean {
  return rows.every((row) => !row.risky)
}
