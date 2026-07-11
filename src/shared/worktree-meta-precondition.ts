/**
 * Serializable precondition for a compare-and-set (CAS) worktree-meta write.
 *
 * A caller records what it believed true (persisted linkedPR, git branch, git
 * head) when it decided to mutate. Main re-validates that belief against its
 * authoritative worktree state at write time and rejects stale mutations,
 * regardless of which renderer sent them (STA-1394). Only the fields present
 * here are compared, so a caller can constrain any subset (linkedPR-only, or
 * the full triple the diverged-clear path needs).
 */
export type WorktreeMetaPrecondition = {
  /** Expected persisted linkedPR at write time; null means "expected unlinked". */
  expectedLinkedPR?: number | null
  /** Expected worktree branch (with or without refs/heads/ prefix — normalized before compare). */
  expectedBranch?: string
  /** Expected git HEAD oid; null means "expected no head". */
  expectedHead?: string | null
}

/** Authoritative "current" snapshot main compares the precondition against. */
export type WorktreeMetaPreconditionState = {
  linkedPR: number | null
  branch: string | undefined
  head: string | null | undefined
}

function stripBranchRef(branch: string | undefined): string | undefined {
  return branch?.replace(/^refs\/heads\//, '')
}

/**
 * Returns true when every field PRESENT in `precondition` still matches
 * `current`. Absent fields are skipped, so an empty precondition always holds.
 */
export function worktreeMetaPreconditionHolds(
  precondition: WorktreeMetaPrecondition,
  current: WorktreeMetaPreconditionState
): boolean {
  // Why: IPC/JSON drops `undefined` keys, so `!== undefined` (not a truthiness
  // check) distinguishes an absent field from a real expected value of `null`.
  if (
    precondition.expectedLinkedPR !== undefined &&
    (precondition.expectedLinkedPR ?? null) !== (current.linkedPR ?? null)
  ) {
    return false
  }
  if (
    precondition.expectedBranch !== undefined &&
    stripBranchRef(precondition.expectedBranch) !== stripBranchRef(current.branch)
  ) {
    return false
  }
  if (
    precondition.expectedHead !== undefined &&
    (precondition.expectedHead ?? null) !== (current.head ?? null)
  ) {
    return false
  }
  return true
}
