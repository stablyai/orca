import type { PRInfo } from './pull-request-types'
import type { Worktree } from '../worktree/types'

export function shouldClearDivergedLinkedMergedPR(args: {
  pr: PRInfo | null
  linkedPRNumber: number | null
  requestHeadOid: string | null
}): boolean {
  const { pr, linkedPRNumber, requestHeadOid } = args
  return (
    linkedPRNumber != null &&
    requestHeadOid !== null &&
    pr?.number === linkedPRNumber &&
    pr.state === 'merged' &&
    // Head-scoped: clear only the worktree whose head diverged, so a PR-number-coalesced broadcast can't clear a sibling still on the PR's line of work.
    pr.headDivergedFromMergedPRAtOid === requestHeadOid &&
    pr.headSha !== requestHeadOid &&
    pr.confirmedContainedHeadOid !== requestHeadOid
  )
}

// Clear linked PR after branch switch only when neither push target nor HEAD matches its head; otherwise Checks remains pinned to old work.
export function shouldClearBranchMismatchedLinkedOpenPR(args: {
  pr: PRInfo | null
  linkedPRNumber: number | null
  branch: string
  requestHeadOid: string | null
  pushTargetBranch: string | null
}): boolean {
  const { pr, linkedPRNumber, branch, requestHeadOid, pushTargetBranch } = args
  const headRefName = pr?.headRefName?.trim() ?? ''
  const currentBranch = branch.replace(/^refs\/heads\//, '').trim()
  return (
    linkedPRNumber != null &&
    pr?.number === linkedPRNumber &&
    // Draft reviews are open PRs too; don't let their distinct renderer state leave a stale durable link wedged after a branch switch.
    (pr.state === 'open' || pr.state === 'draft') &&
    requestHeadOid !== null &&
    headRefName !== '' &&
    currentBranch !== '' &&
    headRefName !== currentBranch &&
    (pushTargetBranch === null || pushTargetBranch !== headRefName) &&
    // A worktree parked on the PR's head commit is the same line of work (e.g. renamed local branch); keep the link.
    !(pr.headSha != null && pr.headSha === requestHeadOid)
  )
}

export function shouldApplyDivergedLinkedPRClear(args: {
  worktree: Pick<Worktree, 'linkedPR' | 'branch' | 'head' | 'isBare' | 'isArchived'> | undefined
  linkedPRNumber: number
  branch: string
  requestHeadOid: string | null
}): boolean {
  const { worktree, linkedPRNumber, branch, requestHeadOid } = args
  return (
    Boolean(worktree) &&
    requestHeadOid !== null &&
    worktree?.linkedPR === linkedPRNumber &&
    worktree.branch.replace(/^refs\/heads\//, '') === branch &&
    worktree.head === requestHeadOid &&
    worktree.isBare !== true &&
    worktree.isArchived !== true
  )
}

export function shouldApplyBranchMismatchedLinkedPRClear(args: {
  worktree: Pick<Worktree, 'linkedPR' | 'branch' | 'head' | 'isBare' | 'isArchived'> | undefined
  linkedPRNumber: number
  branch: string
  requestHeadOid: string | null
}): boolean {
  const { worktree, linkedPRNumber, branch, requestHeadOid } = args
  return (
    Boolean(worktree) &&
    requestHeadOid !== null &&
    worktree?.linkedPR === linkedPRNumber &&
    // Branch-scoped: clear only while still on the branch the mismatch was computed against; a newer switch re-validates.
    worktree.branch.replace(/^refs\/heads\//, '') === branch.replace(/^refs\/heads\//, '') &&
    worktree.head === requestHeadOid &&
    worktree.isBare !== true &&
    worktree.isArchived !== true
  )
}
