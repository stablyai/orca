import type { AppState } from '../../store/types'
import { getRepoMapFromState, getWorktreeMapFromState } from '../../store/selectors'
import type { CheckStatus } from '../../../../shared/github/pull-request-types'
import { getGitHubPRCacheKey } from '../../../../shared/github/github-cache-key'
import { getHostedReviewCacheKey } from '../../store/slices/hosted-review-cache-identity'
import { isGitHubPRSuppressed } from '../../../../shared/worktree/github-pr-suppression'

// Derive input types and cache keys together so a newly read field must also invalidate the cache.
const REQUIRED_INPUT_KEYS = [
  'activeWorktreeId',
  'worktreesByRepo',
  'repos',
  'prCache'
] as const satisfies readonly (keyof AppState)[]
const OPTIONAL_INPUT_KEYS = [
  'settings',
  'hostedReviewCache'
] as const satisfies readonly (keyof AppState)[]
/** @internal Every store field getActiveChecksStatus may read; the cache invalidates on any of them. */
export const ACTIVE_CHECKS_STATUS_INPUT_KEYS = [
  ...REQUIRED_INPUT_KEYS,
  ...OPTIONAL_INPUT_KEYS
] as const

type ActiveChecksStatusState = Pick<AppState, (typeof REQUIRED_INPUT_KEYS)[number]> &
  Partial<Pick<AppState, (typeof OPTIONAL_INPUT_KEYS)[number]>>
type ActiveChecksStatusInputs = {
  [K in (typeof ACTIVE_CHECKS_STATUS_INPUT_KEYS)[number]]: ActiveChecksStatusState[K]
}

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

// The always-mounted sidebar runs this on every store write; cache by input references to avoid rebuilding keys.
let activeChecksStatusCache: {
  inputs: ActiveChecksStatusInputs
  status: CheckStatus | null
} | null = null

/** @internal */
export function clearActiveChecksStatusCacheForTests(): void {
  activeChecksStatusCache = null
}

function hasSameInputs(inputs: ActiveChecksStatusInputs, state: ActiveChecksStatusState): boolean {
  for (const key of ACTIVE_CHECKS_STATUS_INPUT_KEYS) {
    if (inputs[key] !== state[key]) {
      return false
    }
  }
  return true
}

export function getActiveChecksStatus(state: ActiveChecksStatusState): CheckStatus | null {
  const cached = activeChecksStatusCache
  if (cached && hasSameInputs(cached.inputs, state)) {
    return cached.status
  }
  const status = computeActiveChecksStatus(state)
  const inputs = Object.fromEntries(
    ACTIVE_CHECKS_STATUS_INPUT_KEYS.map((key) => [key, state[key]])
  ) as ActiveChecksStatusInputs
  activeChecksStatusCache = { inputs, status }
  return status
}

function computeActiveChecksStatus(state: ActiveChecksStatusState): CheckStatus | null {
  const activeWorktree = state.activeWorktreeId
    ? (getWorktreeMapFromState(state).get(state.activeWorktreeId) ?? null)
    : null
  if (!activeWorktree) {
    return null
  }

  const activeRepo = getRepoMapFromState(state).get(activeWorktree.repoId)
  if (!activeRepo) {
    return null
  }

  const branch = branchDisplayName(activeWorktree.branch)
  if (!branch) {
    return null
  }

  // Repo-ID-scoped refresh keys survive path changes and legacy duplicates.
  const prCacheKey = getGitHubPRCacheKey(
    activeRepo.path,
    activeRepo.id,
    branch,
    state.settings,
    activeRepo.connectionId,
    activeRepo.executionHostId,
    true
  )
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    activeRepo.path,
    branch,
    state.settings,
    activeRepo.id,
    activeRepo.connectionId,
    activeRepo.executionHostId,
    true
  )
  const hostedReview = state.hostedReviewCache?.[hostedReviewCacheKey]?.data ?? null
  if (hostedReview && hostedReview.provider !== 'github') {
    return hostedReview.status
  }
  if (
    (activeWorktree.linkedGitLabMR ?? null) !== null ||
    (activeWorktree.linkedBitbucketPR ?? null) !== null ||
    (activeWorktree.linkedAzureDevOpsPR ?? null) !== null ||
    (activeWorktree.linkedGiteaPR ?? null) !== null
  ) {
    return null
  }
  const branchPR = state.prCache[prCacheKey]?.data ?? null
  if (branchPR && !isGitHubPRSuppressed(activeWorktree, branchPR.number)) {
    return branchPR.checksStatus
  }
  return hostedReview?.provider === 'github' &&
    !isGitHubPRSuppressed(activeWorktree, hostedReview.number)
    ? hostedReview.status
    : null
}
