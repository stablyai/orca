import type {
  GitHubRepositoryIdentity,
  PRCheckDetail,
  Repo,
  Worktree
} from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import {
  getParentPrChecksRefreshIdentity,
  type ParentPrChecksRefreshOutcome
} from './parent-pr-checks-rows'

type FetchHostedReview = (
  repoPath: string,
  branch: string,
  options: {
    force?: boolean
    repoId?: string
    staleWhileRevalidate?: boolean
    linkedGitHubPR?: number | null
    linkedGitLabMR?: number | null
    linkedBitbucketPR?: number | null
    linkedAzureDevOpsPR?: number | null
    linkedGiteaPR?: number | null
  }
) => Promise<HostedReviewInfo | null>

type FetchPRChecks = (
  repoPath: string,
  prNumber: number,
  branch?: string,
  headSha?: string,
  prRepo?: GitHubRepositoryIdentity | null,
  options?: { repoId?: string; force?: boolean }
) => Promise<PRCheckDetail[]>

export type ParentPrChecksRefreshCandidate = {
  identity: string
  worktree: Worktree
  repo: Repo
  branch: string
  linkedReview: boolean
  knownReview: boolean
}

export type RunLimitedParentPrChecksRefreshesArgs = {
  candidates: readonly ParentPrChecksRefreshCandidate[]
  concurrency?: number
  force?: boolean
  fetchHostedReviewForBranch: FetchHostedReview
  fetchPRChecks?: FetchPRChecks
  onOutcome?: (identity: string, outcome: ParentPrChecksRefreshOutcome) => void
}

export function getParentPrChecksRefreshCandidates({
  worktrees,
  repos,
  knownReviewIdentities = new Set()
}: {
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  knownReviewIdentities?: ReadonlySet<string>
}): ParentPrChecksRefreshCandidate[] {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  return worktrees
    .map((worktree) => {
      const repo = repoById.get(worktree.repoId)
      const branch = getBranchName(worktree)
      if (!repo || isFolderRepo(repo) || worktree.isBare || !branch) {
        return null
      }
      const identity = getParentPrChecksRefreshIdentity(worktree, repo, branch)
      return {
        identity,
        worktree,
        repo,
        branch,
        linkedReview: hasLinkedReview(worktree),
        knownReview: knownReviewIdentities.has(identity)
      }
    })
    .filter((candidate): candidate is ParentPrChecksRefreshCandidate => candidate !== null)
    .sort(compareRefreshCandidates)
}

export async function runLimitedParentPrChecksRefreshes({
  candidates,
  concurrency = 3,
  force = false,
  fetchHostedReviewForBranch,
  fetchPRChecks,
  onOutcome
}: RunLimitedParentPrChecksRefreshesArgs): Promise<Map<string, ParentPrChecksRefreshOutcome>> {
  const outcomes = new Map<string, ParentPrChecksRefreshOutcome>()
  const queue = [...candidates].sort(compareRefreshCandidates)
  const workerCount = Math.max(1, Math.min(concurrency, queue.length || 1))
  let cursor = 0

  const runWorker = async (): Promise<void> => {
    while (cursor < queue.length) {
      const candidate = queue[cursor]
      cursor += 1
      outcomes.set(candidate.identity, { kind: 'loading' })
      onOutcome?.(candidate.identity, { kind: 'loading' })
      const outcome = await refreshParentPrChecksCandidate(
        candidate,
        fetchHostedReviewForBranch,
        fetchPRChecks,
        force
      )
      outcomes.set(candidate.identity, outcome)
      onOutcome?.(candidate.identity, outcome)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker))
  return outcomes
}

async function refreshParentPrChecksCandidate(
  candidate: ParentPrChecksRefreshCandidate,
  fetchHostedReviewForBranch: FetchHostedReview,
  fetchPRChecks: FetchPRChecks | undefined,
  force: boolean
): Promise<ParentPrChecksRefreshOutcome> {
  try {
    const review = await fetchHostedReviewForBranch(candidate.repo.path, candidate.branch, {
      force,
      repoId: candidate.repo.id,
      linkedGitHubPR: candidate.worktree.linkedPR ?? null,
      linkedGitLabMR: candidate.worktree.linkedGitLabMR ?? null,
      linkedBitbucketPR: candidate.worktree.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: candidate.worktree.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: candidate.worktree.linkedGiteaPR ?? null,
      staleWhileRevalidate: true
    })
    if (!review) {
      // Why: the existing hosted-review API can collapse provider errors and
      // successful misses into null. Keep null neutral so the overview neither
      // claims "No PR" nor overstates that a provider failed.
      return { kind: 'unavailable' }
    }
    if (review.provider === 'github') {
      await fetchPRChecks?.(
        candidate.repo.path,
        review.number,
        candidate.branch,
        review.headSha,
        null,
        { repoId: candidate.repo.id, force }
      )
    }
    return { kind: 'found', review }
  } catch (error) {
    return { kind: 'error', error }
  }
}

function compareRefreshCandidates(
  left: ParentPrChecksRefreshCandidate,
  right: ParentPrChecksRefreshCandidate
): number {
  const leftPriority = getRefreshPriority(left)
  const rightPriority = getRefreshPriority(right)
  return (
    leftPriority - rightPriority ||
    (right.worktree.lastActivityAt ?? 0) - (left.worktree.lastActivityAt ?? 0) ||
    left.worktree.displayName.localeCompare(right.worktree.displayName)
  )
}

function getRefreshPriority(candidate: ParentPrChecksRefreshCandidate): number {
  if (candidate.linkedReview) {
    return 0
  }
  if (candidate.knownReview) {
    return 1
  }
  return 2
}

function getBranchName(worktree: Worktree): string | null {
  const identity = getWorktreeGitIdentityDisplay(worktree)
  return identity?.kind === 'branch' ? identity.branchName : null
}

function hasLinkedReview(worktree: Worktree): boolean {
  return Boolean(
    worktree.linkedPR ??
    worktree.linkedGitLabMR ??
    worktree.linkedBitbucketPR ??
    worktree.linkedAzureDevOpsPR ??
    worktree.linkedGiteaPR ??
    null
  )
}
