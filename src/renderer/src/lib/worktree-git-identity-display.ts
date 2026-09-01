import type { GitConflictOperation } from '../../../shared/git-status-types'

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
  // Why: git detaches HEAD while it replays commits, so `branch` is empty and the
  // plain identity collapses to "Detached HEAD · <sha>" — true, but it hides the
  // branch the user is actually rebasing. Kept as structured data (no prose) so
  // the label and tooltip stay translatable at the render site.
  | {
      kind: 'operation'
      operation: Exclude<GitConflictOperation, 'unknown'>
      branchName: string
      shortHead: string
      head: string
    }

export function shortGitHead(head: string | null | undefined): string {
  return (head ?? '').trim().slice(0, 7)
}

export function getDetachedHeadTooltip(shortHead: string): string {
  return `Detached HEAD at ${shortHead}. You are viewing a commit, not a branch.`
}

export function getWorktreeGitIdentityDisplay(input: {
  branch?: string | null
  head?: string | null
}): WorktreeGitIdentityDisplay | null {
  const branchName = (input.branch ?? '').replace(/^refs\/heads\//, '').trim()
  if (branchName) {
    return { kind: 'branch', branchName }
  }

  const shortHead = shortGitHead(input.head)
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

/**
 * Identity while a merge/rebase/cherry-pick is in flight. Falls back to the plain
 * identity when nothing is running, or when the host could not name the branch
 * being replayed — an old host omits `operationHeadName`, and guessing a name is
 * worse than showing today's detached label.
 */
export function getWorktreeGitOperationIdentityDisplay(input: {
  branch?: string | null
  head?: string | null
  conflictOperation: GitConflictOperation
  operationHeadName?: string | null
}): WorktreeGitIdentityDisplay | null {
  const plain = getWorktreeGitIdentityDisplay(input)
  if (input.conflictOperation === 'unknown') {
    return plain
  }
  const branchName = (input.operationHeadName ?? '').replace(/^refs\/heads\//, '').trim()
  if (!branchName) {
    // Why: mid-rebase `branch` is empty, but a merge/cherry-pick keeps HEAD on its
    // branch — that name is still the honest answer when head-name is unavailable.
    return plain
  }
  const head = (input.head ?? '').trim()
  return {
    kind: 'operation',
    operation: input.conflictOperation,
    branchName,
    shortHead: shortGitHead(head),
    head
  }
}
