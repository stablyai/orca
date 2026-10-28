import type { GitPushTarget } from './worktree/types'

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

/** Git forbids one branch in two worktrees; recognize both short and refs/heads names before offering reuse. */
export function isBranchCheckedOutInWorktrees(
  branchName: string,
  worktreeBranches: readonly string[]
): boolean {
  return worktreeBranches.some((ref) => ref.replace(/^refs\/heads\//, '') === branchName)
}

export function getComposerRepoWorktreeBranches(
  worktrees: readonly { repoId: string; branch: string }[],
  repoId: string | null
): string[] {
  return repoId
    ? worktrees.filter((worktree) => worktree.repoId === repoId).map((worktree) => worktree.branch)
    : []
}

function isLocalBranchSelection(refName: string, localBranchName: string): boolean {
  return refName === localBranchName || refName === `refs/heads/${localBranchName}`
}

/** Reuse only local branches not checked out elsewhere. Default on when selection auto-derived the workspace name; user-edited names default to branching unless explicitly opting in (#5181). */
export function resolveComposerBranchReuse(args: {
  refName: string
  localBranchName: string
  selectionProducedOverride: boolean
  branchCheckedOutElsewhere: boolean
}): { reuseEligibleBranch: string | null; defaultReuse: boolean } {
  const reuseEligibleBranch =
    isLocalBranchSelection(args.refName, args.localBranchName) && !args.branchCheckedOutElsewhere
      ? args.localBranchName
      : null
  return {
    reuseEligibleBranch,
    defaultReuse: reuseEligibleBranch !== null && args.selectionProducedOverride
  }
}

/** Do not pin checked-out local branches as overrides: collision suffixes would silently create another branch. Derive a fresh name from the selected base instead (#5181). */
export function resolveComposerReuseOverride(args: {
  refName: string
  localBranchName: string
  branchNameOverride: string | undefined
  branchCheckedOutElsewhere: boolean
}): string | undefined {
  if (
    args.branchCheckedOutElsewhere &&
    isLocalBranchSelection(args.refName, args.localBranchName)
  ) {
    return undefined
  }
  return args.branchNameOverride
}

export type ComposerBranchPick = ComposerBranchSelection & {
  reuseEligibleBranch: string | null
  defaultReuse: boolean
}

export function resolveComposerBranchPick(args: {
  refName: string
  localBranchName: string
  currentName: string
  lastAutoName: string
  worktreeBranches: readonly string[]
}): ComposerBranchPick {
  const selection = resolveComposerBranchSelection(args)
  const branchCheckedOutElsewhere = isBranchCheckedOutInWorktrees(
    args.localBranchName,
    args.worktreeBranches
  )
  const reuse = resolveComposerBranchReuse({
    refName: args.refName,
    localBranchName: args.localBranchName,
    selectionProducedOverride: selection.branchNameOverride !== undefined,
    branchCheckedOutElsewhere
  })
  return {
    ...selection,
    branchNameOverride: resolveComposerReuseOverride({
      refName: args.refName,
      localBranchName: args.localBranchName,
      branchNameOverride: selection.branchNameOverride,
      branchCheckedOutElsewhere
    }),
    ...reuse
  }
}

/** Branch mode preserves typed slash names for downstream Git validation while sanitizing folder names separately (#6721). Keep supplied overrides verbatim only for user-preserved names or matching auto-names. */
export function resolveComposerBranchNameOverrideForCreate(args: {
  branchNameOverride: string | undefined
  branchAutoName: string
  workspaceName: string
  preserveWorkspaceNameEdits: boolean
  createBranchFromWorkspaceName?: boolean
}): string | undefined {
  if (!args.branchNameOverride) {
    return args.createBranchFromWorkspaceName && args.workspaceName.includes('/')
      ? args.workspaceName
      : undefined
  }
  if (args.preserveWorkspaceNameEdits) {
    return args.branchNameOverride
  }
  return args.workspaceName === args.branchAutoName ? args.branchNameOverride : undefined
}

export function resolveComposerManualBranchNameChange(args: {
  value: string | undefined
  pushTarget: GitPushTarget | undefined
  forkPushWarning: string | null
}): {
  branchNameOverride: string | undefined
  pushTarget: GitPushTarget | undefined
  forkPushWarning: string | null
} {
  const branchNameOverride = args.value?.trim() || undefined
  if (args.pushTarget && args.pushTarget.branchName !== branchNameOverride) {
    return {
      branchNameOverride,
      pushTarget: undefined,
      forkPushWarning: null
    }
  }
  return {
    branchNameOverride,
    pushTarget: args.pushTarget,
    forkPushWarning: args.forkPushWarning
  }
}
