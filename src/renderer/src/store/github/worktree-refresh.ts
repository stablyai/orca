import type { AppState } from '../types'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-request-refresh-types'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import { isMacAppDataPath } from '@/lib/passive-macos-app-data-access'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { prCacheKey } from './cache-identity'
import { settingsForGitHubRepoOwner } from './work-item-routing'
import { githubHostedReviewFallbackPRNumber } from './pr-result-routing'
import type { GitHubPRFallbackSource } from './cache-model'

export function findWorktreeById(state: AppState, worktreeId: string): Worktree | null {
  return getWorktreeLookupIndex(state).byId.get(worktreeId)?.first ?? null
}

type WorktreeLookupEntry = {
  first: Worktree
  unique: Worktree | null
}

export type WorktreeLookupIndex = {
  byId: Map<string, WorktreeLookupEntry>
  repoHostIdsByRepoId: Map<string, Set<string>>
}

const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}
const EMPTY_WORKTREE_REPOS: AppState['repos'] = []

export function buildWorktreeLookupIndex(state: AppState): WorktreeLookupIndex {
  const byId = new Map<string, WorktreeLookupEntry>()
  for (const worktrees of Object.values(state.worktreesByRepo ?? EMPTY_WORKTREES_BY_REPO)) {
    for (const worktree of worktrees) {
      const worktreeId = worktree.id
      const existing = byId.get(worktreeId)
      if (existing) {
        existing.unique = null
      } else {
        byId.set(worktreeId, { first: worktree, unique: worktree })
      }
    }
  }

  const repoHostIdsByRepoId = new Map<string, Set<string>>()
  for (const repo of state.repos ?? []) {
    let hostIds = repoHostIdsByRepoId.get(repo.id)
    if (!hostIds) {
      hostIds = new Set<string>()
      repoHostIdsByRepoId.set(repo.id, hostIds)
    }
    hostIds.add(getRepoExecutionHostId(repo))
  }
  return { byId, repoHostIdsByRepoId }
}

// Why: worktree/owner updates replace these snapshots, while weak ownership avoids retaining superseded state.
const worktreeLookupIndexes = new WeakMap<
  AppState['worktreesByRepo'],
  { repos: AppState['repos']; index: WorktreeLookupIndex }
>()

export function getWorktreeLookupIndex(state: AppState): WorktreeLookupIndex {
  const worktreesByRepo = state.worktreesByRepo ?? EMPTY_WORKTREES_BY_REPO
  const repos = state.repos ?? EMPTY_WORKTREE_REPOS
  const cached = worktreeLookupIndexes.get(worktreesByRepo)
  if (cached && cached.repos === repos) {
    return cached.index
  }
  const index = buildWorktreeLookupIndex(state)
  worktreeLookupIndexes.set(worktreesByRepo, { repos, index })
  return index
}

export function findUniqueWorktreeById(
  state: AppState,
  worktreeId: string,
  executionHostId?: string,
  lookupIndex = getWorktreeLookupIndex(state)
): Worktree | null {
  const match = lookupIndex.byId.get(worktreeId)?.unique ?? null
  // Why: metadata persistence is keyed only by worktree id; an id owned by two hosts is non-unique so destructive clears fail closed.
  if (!match || executionHostId === undefined) {
    return match
  }
  const expectedHostId = normalizeExecutionHostId(executionHostId) ?? LOCAL_EXECUTION_HOST_ID
  const explicitWorktreeHostId = normalizeExecutionHostId(match.hostId)
  if (explicitWorktreeHostId) {
    return explicitWorktreeHostId === expectedHostId ? match : null
  }
  const repoHostIds = lookupIndex.repoHostIdsByRepoId.get(match.repoId)
  // Pre-host persisted rows are safe only when their repo has one unambiguous owner.
  if (!repoHostIds || repoHostIds.size !== 1 || !repoHostIds.has(expectedHostId)) {
    return null
  }
  return match
}

export function isStaleExactLinkedPRLookup(
  state: AppState,
  worktreeId: string | undefined,
  linkedPRNumber: number | null | undefined,
  lookupIndex?: WorktreeLookupIndex
): boolean {
  if (!worktreeId || linkedPRNumber == null) {
    return false
  }
  const worktree = lookupIndex
    ? (lookupIndex.byId.get(worktreeId)?.first ?? null)
    : findWorktreeById(state, worktreeId)
  return worktree?.linkedPR !== linkedPRNumber
}

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

// Why: a linked PR is branch-scoped; it's stale once the worktree switched branches with neither push target nor HEAD at the PR head, else Checks stays pinned to the old branch's PR.
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

export function buildPRRefreshCandidate(
  state: AppState,
  worktree: Worktree,
  repoPath?: string,
  repoOverride?: Repo
): GitHubPRRefreshCandidate | null {
  const repo = repoOverride ?? getGitHubRepoLookupIndex(state.repos).findById(worktree.repoId)
  if (!repo) {
    return null
  }
  if (isMacAppDataPath(repoPath ?? repo.path)) {
    return null
  }
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  const cacheKey = prCacheKey(
    repoPath ?? repo.path,
    repo.id,
    branch,
    settingsForGitHubRepoOwner(state.settings, repo),
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const cachedPR = state.prCache[cacheKey]?.data ?? null
  const hostedReviewFallbackPRNumber = githubHostedReviewFallbackPRNumber(
    state,
    repoPath ?? repo.path,
    repo.id,
    branch,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const cachedFallbackPRNumber = cachedPR?.number ?? null
  // Why: a merged PR is a valid fallback only while the worktree sits on its head or a confirmed-contained commit — else the branch moved on.
  const cachedMergedPRMovedPastHead =
    worktree.linkedPR == null &&
    cachedPR?.state === 'merged' &&
    cachedPR.headSha !== worktree.head &&
    cachedPR.confirmedContainedHeadOid !== worktree.head
  const fallbackPRNumber =
    worktree.linkedPR == null && !cachedMergedPRMovedPastHead
      ? (cachedFallbackPRNumber ?? hostedReviewFallbackPRNumber)
      : null
  const fallbackPRSource: GitHubPRFallbackSource | null =
    worktree.linkedPR != null || fallbackPRNumber == null
      ? null
      : cachedFallbackPRNumber != null
        ? 'pr-cache'
        : 'hosted-review'
  const sshStatus = repo.connectionId
    ? state.sshConnectionStates.get(repo.connectionId)?.status
    : null
  return {
    repoId: repo.id,
    repoPath: repoPath ?? repo.path,
    repoKind: repo.kind ?? 'git',
    branch,
    cacheKey,
    worktreeId: worktree.id,
    currentHeadOid: worktree.head ?? null,
    // Why: persisted linked PR metadata is exact; PR cache numbers are only fallback hints after branch-lookup misses.
    linkedPRNumber: worktree.linkedPR ?? null,
    fallbackPRNumber,
    fallbackPRSource,
    isBare: worktree.isBare,
    isArchived: worktree.isArchived,
    connectionId: repo.connectionId ?? null,
    executionHostId: repo.executionHostId ?? null,
    connectionState: repo.connectionId
      ? sshStatus === 'connected'
        ? 'connected'
        : 'disconnected'
      : 'unknown',
    cachedFetchedAt: state.prCache[cacheKey]?.fetchedAt ?? null,
    cachedHasPR: cachedPR ? true : state.prCache[cacheKey] ? false : null,
    cachedPRState: cachedPR?.state ?? null,
    cachedChecksStatus: cachedPR?.checksStatus ?? null,
    cachedMergeable: cachedPR?.mergeable ?? null,
    cachedMergeStateStatus: cachedPR?.mergeStateStatus ?? null
  }
}
