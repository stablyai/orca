export type WorktreeGitIdentityDisplay =
  | {
      kind: 'branch'
      branchName: string
    }
  | {
      kind: 'detached'
      shortHead: string
      sidebarLabel: string
      sourceControlLabel: string
      tooltip: string
    }
  | {
      kind: 'rebasing'
      // Recovered original branch, or null when it can't be recovered (e.g. a rebase
      // started from a detached HEAD, where git records no branch in head-name).
      branchName: string | null
      shortHead: string
      sidebarLabel: string
      sourceControlLabel: string
      tooltip: string
    }

export function shortGitHead(head: string | null | undefined): string {
  return (head ?? '').trim().slice(0, 7)
}

export function getDetachedHeadTooltip(shortHead: string): string {
  return `Detached HEAD at ${shortHead}. You are viewing a commit, not a branch.`
}

export function getRebasingTooltip(branchName: string | null, shortHead: string): string {
  return branchName
    ? `Rebasing ${branchName}. HEAD is temporarily detached; your branch is intact.`
    : `Rebase in progress at ${shortHead}. HEAD is temporarily detached.`
}

/**
 * Branch name to resolve a worktree's PR against, or null when there is none.
 * Why: mid-rebase the PR still lives on the original branch, so a recovered
 * `rebasing` branch resolves PRs just like a live branch.
 */
export function getWorktreeIdentityBranchName(
  identity: WorktreeGitIdentityDisplay | null
): string | null {
  return identity?.kind === 'branch' || identity?.kind === 'rebasing' ? identity.branchName : null
}

export function getWorktreeGitIdentityDisplay(input: {
  branch?: string | null
  head?: string | null
  rebasing?: boolean
  rebaseBranch?: string | null
}): WorktreeGitIdentityDisplay | null {
  const branchName = (input.branch ?? '').replace(/^refs\/heads\//, '').trim()
  if (branchName) {
    return { kind: 'branch', branchName }
  }

  const shortHead = shortGitHead(input.head)

  if (input.rebasing) {
    const rebaseBranch = (input.rebaseBranch ?? '').replace(/^refs\/heads\//, '').trim() || null
    return {
      kind: 'rebasing',
      branchName: rebaseBranch,
      shortHead,
      sidebarLabel: rebaseBranch ? `${rebaseBranch} (rebasing)` : `Rebasing @ ${shortHead}`,
      sourceControlLabel: rebaseBranch ? `${rebaseBranch} (rebasing)` : `Rebasing · ${shortHead}`,
      tooltip: getRebasingTooltip(rebaseBranch, shortHead)
    }
  }

  if (!shortHead) {
    return null
  }

  return {
    kind: 'detached',
    shortHead,
    sidebarLabel: `Detached HEAD @ ${shortHead}`,
    sourceControlLabel: `Detached HEAD · ${shortHead}`,
    tooltip: getDetachedHeadTooltip(shortHead)
  }
}
