import type { WorktreeGitCopy } from '@/lib/worktree-git-copy'
import type {
  HostedReviewCreationEligibility,
  HostedReviewProvider
} from '../../../../../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../../../../../shared/hosted-review-refs'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { summarizeCommitFailure } from '../commit/commit-failure-summary'
import { getStageAllPaths } from '../../../../../../shared/source-control-discard-all-sequence'

export type CreatePrIntentRunToken = {
  repoId: string
  worktreeId: string
  worktreePath: string
  branch: string
  provider: HostedReviewProvider
  baseRef?: string | null
  /**
   * The worktree copy the run started on, pinned with its transport: a same-path twin on another
   * host shares the id, and re-resolving later could land on it. Null refuses every call.
   */
  pinnedCopy: WorktreeGitCopy | null
  startedAt: number
}

export type CreatePrIntentCurrentTarget = {
  repoId?: string | null
  worktreeId?: string | null
  worktreePath?: string | null
  branch?: string | null
  baseRef?: string | null
}

type CreatePrIntentReviewFields = {
  base: string
  title: string
  body: string
  draft: boolean
}

type CreatePrIntentReviewGeneration =
  | { success: true; fields: CreatePrIntentReviewFields }
  | { success: false; error: string }

export type CreatePrIntentGeneratedReviewFields =
  | { ok: true; fields: CreatePrIntentReviewFields }
  | { ok: false; error: string }

export function createCreatePrIntentRunToken(input: Omit<CreatePrIntentRunToken, 'startedAt'>) {
  return { ...input, startedAt: Date.now() }
}

function normalizeCreatePrIntentBaseIdentityRef(ref: string | null | undefined): string {
  const trimmed = ref?.trim()
  if (!trimmed) {
    return ''
  }
  // Keep remote-qualified local refs distinct; only hosted review APIs strip them to branch names.
  if (trimmed.startsWith('refs/remotes/')) {
    return trimmed.slice('refs/remotes/'.length)
  }
  if (trimmed.startsWith('remotes/')) {
    return trimmed.slice('remotes/'.length)
  }
  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length)
  }
  return trimmed
}

export function createPrIntentRunTokenMatches(
  token: CreatePrIntentRunToken,
  current: CreatePrIntentCurrentTarget
): boolean {
  return (
    token.repoId === current.repoId &&
    token.worktreeId === current.worktreeId &&
    token.worktreePath === current.worktreePath &&
    token.branch === current.branch &&
    normalizeCreatePrIntentBaseIdentityRef(token.baseRef) ===
      normalizeCreatePrIntentBaseIdentityRef(current.baseRef)
  )
}

export function createPrIntentCurrentTargetConflictsWithToken(
  token: CreatePrIntentRunToken,
  current: CreatePrIntentCurrentTarget
): boolean {
  // Navigation is allowed; only drift within the original worktree conflicts with this intent.
  if (current.worktreeId !== token.worktreeId) {
    return false
  }
  return !createPrIntentRunTokenMatches(token, current)
}

export function createPrIntentGitStatusMatchesToken(
  token: CreatePrIntentRunToken,
  status: { branch?: string | null }
): boolean {
  const branch = normalizeHostedReviewHeadRef(status.branch ?? '')
  return branch.length > 0 && branch === token.branch
}

export function getCreatePrIntentStagePaths(grouped: {
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
}): string[] {
  return [
    ...getStageAllPaths(grouped.unstaged, 'unstaged'),
    ...getStageAllPaths(grouped.untracked, 'untracked')
  ]
}

export function resolveCreatePrIntentReviewBase({
  currentBaseRef,
  eligibilityDefaultBaseRef,
  composerBaseRef
}: {
  currentBaseRef?: string | null
  eligibilityDefaultBaseRef?: string | null
  composerBaseRef?: string | null
}): string {
  // Match the composer's remote-validated eligibility base, correcting local-only stack parents; fall back only when no default exists.
  return normalizeHostedReviewBaseRef(
    eligibilityDefaultBaseRef?.trim() || currentBaseRef?.trim() || composerBaseRef?.trim() || ''
  )
}

export function shouldAttemptCreateHostedReviewForIntent(
  eligibility: HostedReviewCreationEligibility
): boolean {
  return (
    eligibility.canCreate ||
    // Real unavailable-lookup results have a head; loading placeholders share the outcome/reason but lack a branch.
    (eligibility.reviewLookupOutcome === 'unavailable' &&
      eligibility.blockedReason === null &&
      Boolean(eligibility.head?.trim()))
  )
}

export function shouldGenerateHostedReviewDetailsForIntent(
  eligibility: HostedReviewCreationEligibility
): boolean {
  // Generate before main rechecks unavailable lookups so recovered creates never submit fallback fields.
  return shouldAttemptCreateHostedReviewForIntent(eligibility)
}

export function resolveCreatePrIntentGeneratedReviewFields(
  current: CreatePrIntentReviewFields,
  generated: CreatePrIntentReviewGeneration
): CreatePrIntentGeneratedReviewFields {
  if (!generated.success) {
    return { ok: false, error: generated.error }
  }
  return {
    ok: true,
    fields: {
      // Automatic submission must not let generated fields silently retarget the review.
      base: current.base,
      title: generated.fields.title.trim() || current.title,
      // Empty descriptions are valid across composer/providers and must remain valid generation results.
      body: generated.fields.body,
      // Without a review form, generation may mark unfinished work but cannot override the user's draft choice.
      draft: current.draft || generated.fields.draft
    }
  }
}

export function getCreatePrIntentCommitFailureNoticeMessage(
  commitError: string | null | undefined,
  copy: {
    fallback: string
    withSummary: (summary: string) => string
  } = {
    fallback: 'Could not commit changes. Fix the issue, then retry Create PR.',
    withSummary: (summary: string) =>
      `Commit blocked: ${summary} Fix the issue, then retry Create PR.`
  }
): string {
  const summary = commitError ? summarizeCommitFailure(commitError) : null

  if (!summary) {
    return copy.fallback
  }

  return copy.withSummary(summary)
}
