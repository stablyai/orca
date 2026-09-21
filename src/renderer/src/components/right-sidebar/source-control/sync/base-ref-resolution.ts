import type { GitUpstreamStatus } from '../../../../../../shared/git-status-types'

export function resolveSourceControlBaseRef(input: {
  worktreeBaseRef?: string | null
  reviewBaseRefName?: string | null
  repoBaseRef?: string | null
  defaultBaseRef?: string | null
}): string | null {
  const worktreeBaseRef = input.worktreeBaseRef?.trim() || null
  const hasReviewBaseRefName = Boolean(input.reviewBaseRefName?.trim())
  const reviewBaseRef = resolveHostedReviewCompareBaseRef(input.reviewBaseRefName, [
    input.repoBaseRef,
    input.defaultBaseRef
  ])
  if (worktreeBaseRef && isFullGitCommitOid(worktreeBaseRef) && hasReviewBaseRefName) {
    return reviewBaseRef
  }
  return worktreeBaseRef || input.repoBaseRef?.trim() || input.defaultBaseRef?.trim() || null
}

// Why: the compare base is distinct from the PR/rebase target; when enabled it defaults to the branch upstream (else effectiveBaseRef) to surface local changes.
export function resolveSourceControlCompareBaseRef(input: {
  enabled: boolean
  worktreeBaseRef?: string | null
  repoBaseRef?: string | null
  upstreamName?: string | null
  fallbackBaseRef?: string | null
}): string | null {
  if (!input.enabled) {
    return input.fallbackBaseRef?.trim() || null
  }
  const pinned = input.worktreeBaseRef?.trim() || input.repoBaseRef?.trim()
  if (pinned) {
    return pinned
  }
  return input.upstreamName?.trim() || input.fallbackBaseRef?.trim() || null
}

// Why: only clear the branch-compare summary once we truly have no base; compareBaseRef is momentarily null while upstream loads, which would flicker.
export function shouldClearBranchCompareForMissingBase(input: {
  isFolder: boolean
  compareBaseRef: string | null
  remoteStatus: GitUpstreamStatus | undefined
}): boolean {
  if (input.isFolder || input.compareBaseRef) {
    return false
  }
  return input.remoteStatus !== undefined
}

export function resolveSourceControlPickerBaseRef(input: {
  pinnedBaseRef?: string | null
  effectiveBaseRef?: string | null
}): string | undefined {
  const pinnedBaseRef = input.pinnedBaseRef?.trim()
  if (!pinnedBaseRef) {
    return undefined
  }
  return input.effectiveBaseRef?.trim() || pinnedBaseRef
}

function isFullGitCommitOid(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value)
}

function resolveHostedReviewCompareBaseRef(
  baseRefName: string | null | undefined,
  candidates: (string | null | undefined)[]
): string | null {
  const branch = baseRefName?.trim()
  if (!branch) {
    return null
  }
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (!trimmed) {
      continue
    }
    if (getCompareBaseCandidateBranchName(trimmed) === branch) {
      return trimmed
    }
  }
  for (const candidate of candidates) {
    const rewritten = rewriteCompareBaseBranchFromCandidate(candidate, branch)
    if (rewritten) {
      return rewritten
    }
  }
  return null
}

function getCompareBaseCandidateBranchName(candidate: string): string {
  const remoteRefPrefix = 'refs/remotes/'
  if (candidate.startsWith(remoteRefPrefix)) {
    const remoteAndBranch = candidate.slice(remoteRefPrefix.length)
    const slashIndex = remoteAndBranch.indexOf('/')
    return slashIndex > 0 ? remoteAndBranch.slice(slashIndex + 1) : remoteAndBranch
  }
  const headsRefPrefix = 'refs/heads/'
  if (candidate.startsWith(headsRefPrefix)) {
    return candidate.slice(headsRefPrefix.length)
  }
  const slashIndex = candidate.indexOf('/')
  return slashIndex > 0 ? candidate.slice(slashIndex + 1) : candidate
}

function rewriteCompareBaseBranchFromCandidate(
  candidate: string | null | undefined,
  branch: string
): string | null {
  const trimmed = candidate?.trim()
  if (!trimmed) {
    return null
  }
  const remoteRefPrefix = 'refs/remotes/'
  if (trimmed.startsWith(remoteRefPrefix)) {
    const remoteAndBranch = trimmed.slice(remoteRefPrefix.length)
    const slashIndex = remoteAndBranch.indexOf('/')
    return slashIndex > 0
      ? `${remoteRefPrefix}${remoteAndBranch.slice(0, slashIndex)}/${branch}`
      : null
  }
  const headsRefPrefix = 'refs/heads/'
  if (trimmed.startsWith(headsRefPrefix)) {
    return `${headsRefPrefix}${branch}`
  }
  const slashIndex = trimmed.indexOf('/')
  return slashIndex > 0 ? `${trimmed.slice(0, slashIndex)}/${branch}` : null
}
