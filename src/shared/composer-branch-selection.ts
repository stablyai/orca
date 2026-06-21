export type ComposerBranchSelection = {
  baseBranch: string
  branchNameOverride: string | undefined
  branchAutoName: string
  name: string | undefined
  lastAutoName: string | undefined
}

export function resolveComposerBranchSelection(args: {
  refName: string
  localBranchName: string
  currentName: string
  lastAutoName: string
}): ComposerBranchSelection {
  const trimmedCurrentName = args.currentName.trim()
  const shouldAutoName =
    !trimmedCurrentName ||
    args.currentName === args.lastAutoName ||
    args.localBranchName.startsWith(trimmedCurrentName) ||
    args.refName.startsWith(trimmedCurrentName)
  if (!shouldAutoName) {
    return {
      baseBranch: args.refName,
      branchNameOverride: undefined,
      branchAutoName: '',
      name: undefined,
      lastAutoName: undefined
    }
  }
  return {
    baseBranch: args.refName,
    branchNameOverride: args.localBranchName,
    branchAutoName: args.localBranchName,
    name: args.localBranchName,
    lastAutoName: args.localBranchName
  }
}

/**
 * True when `branchName` is already checked out in one of the given worktree
 * branch refs (which may be `refs/heads/foo` or short `foo`). Git refuses to
 * check out a branch in two worktrees, so such a branch cannot be reused.
 */
export function isBranchCheckedOutInWorktrees(
  branchName: string,
  worktreeBranches: readonly string[]
): boolean {
  return worktreeBranches.some((ref) => ref.replace(/^refs\/heads\//, '') === branchName)
}

/**
 * Issue #5181: decide whether a picked branch row is an existing LOCAL branch
 * that can be reused (checked out) instead of branched off, and whether reuse
 * should default ON.
 *
 * Reuse is only possible for a LOCAL branch (ref === local name; remote-only
 * refs carry an `origin/`-style prefix) that is NOT already checked out in
 * another worktree — git allows a branch in only one worktree at a time. Reuse
 * defaults ON only when the worktree name was auto-derived from the branch (the
 * selection produced a branch-name override); a user who typed a custom
 * worktree name first is branching off the ref, so reuse stays OFF unless they
 * opt in.
 */
export function resolveComposerBranchReuse(args: {
  refName: string
  localBranchName: string
  selectionProducedOverride: boolean
  branchCheckedOutElsewhere: boolean
}): { reuseEligibleBranch: string | null; defaultReuse: boolean } {
  const reuseEligibleBranch =
    args.refName === args.localBranchName && !args.branchCheckedOutElsewhere
      ? args.localBranchName
      : null
  return {
    reuseEligibleBranch,
    defaultReuse: reuseEligibleBranch !== null && args.selectionProducedOverride
  }
}

/**
 * Issue #5181: the branch-name override to apply for a picked branch. A local
 * branch already checked out in another worktree can't be reused, so it must
 * NOT be pinned as the override — pinning it would collide and silently produce
 * a suffixed branch. In that case fall back to letting the worktree name derive
 * a fresh branch from the selected ref as base; otherwise use the selection's
 * override unchanged.
 */
export function resolveComposerReuseOverride(args: {
  refName: string
  localBranchName: string
  branchNameOverride: string | undefined
  branchCheckedOutElsewhere: boolean
}): string | undefined {
  if (args.branchCheckedOutElsewhere && args.refName === args.localBranchName) {
    return undefined
  }
  return args.branchNameOverride
}

export function resolveComposerBranchNameOverrideForCreate(args: {
  branchNameOverride: string | undefined
  branchAutoName: string
  workspaceName: string
  preserveWorkspaceNameEdits: boolean
}): string | undefined {
  if (!args.branchNameOverride) {
    return undefined
  }
  if (args.preserveWorkspaceNameEdits) {
    return args.branchNameOverride
  }
  return args.workspaceName === args.branchAutoName ? args.branchNameOverride : undefined
}
