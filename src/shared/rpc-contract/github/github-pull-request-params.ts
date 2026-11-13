import { z } from 'zod'
import type { GitHubPRRefreshReason } from '../../github/pull-requests/refresh/pull-request-refresh-types'
import { OptionalGhAccountExpectation, RepoSelector, SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from '../rpc-param-primitives'

export const OptionalPRRefreshReason = z
  .unknown()
  .optional()
  .transform((value): GitHubPRRefreshReason | undefined => {
    return value === 'visible' ||
      value === 'active' ||
      value === 'post-push' ||
      value === 'manual' ||
      value === 'swr'
      ? value
      : undefined
  })

export const PrForBranch = RepoSelector.extend({
  branch: requiredString('Missing branch'),
  reason: OptionalPRRefreshReason,
  userRefresh: z.boolean().optional(),
  acceptRevalidationOnly: z.boolean().optional(),
  selected: z.boolean().optional(),
  linkedPRNumber: z.number().int().positive().nullable().optional(),
  fallbackPRNumber: z.number().int().positive().nullable().optional(),
  acceptMergedFallbackPR: z.boolean().optional(),
  currentHeadOid: z.string().nullable().optional()
})

export const PullRequest = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  noCache: z.boolean().optional(),
  prRepo: SlugRepo.nullable().optional()
})

export const PRCommentReaction = RepoSelector.extend({
  reactionSubjectId: requiredString('Missing reaction subject ID'),
  content: z.enum(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']),
  reacted: z.boolean(),
  prRepo: SlugRepo.nullable().optional()
})

export const PullRequestChecks = PullRequest.extend({
  headSha: OptionalString,
  userRefresh: z.boolean().optional()
})

export const PullRequestCheckDetails = RepoSelector.extend({
  checkRunId: z.number().int().positive().optional(),
  workflowRunId: z.number().int().positive().optional(),
  checkName: OptionalString,
  url: OptionalString.nullable().optional(),
  prRepo: SlugRepo.nullable().optional()
})

export const RerunPullRequestChecks = PullRequest.extend({
  headSha: OptionalString,
  failedOnly: z.boolean().optional()
})

export const PullRequestFileContents = RepoSelector.extend({
  prNumber: z.number().int().positive(),
  prRepo: SlugRepo.nullable().optional(),
  path: requiredString('Missing file path'),
  oldPath: OptionalString,
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  headSha: requiredString('Missing head SHA'),
  baseSha: requiredString('Missing base SHA')
})

export const PullRequestFileViewed = RepoSelector.extend({
  expectedGhAccount: OptionalGhAccountExpectation,
  prRepo: SlugRepo.nullable().optional(),
  pullRequestId: requiredString('Missing pull request ID'),
  path: requiredString('Missing file path'),
  viewed: z.boolean()
})

export const ReviewThread = RepoSelector.extend({
  prRepo: SlugRepo.nullable().optional(),
  threadId: requiredString('Missing thread ID'),
  resolve: z.boolean()
})

const PRDetailRecoveryIdentityParams = z.object({
  sourceEpoch: requiredString('Missing source epoch'),
  repoId: requiredString('Missing repo id'),
  repoPath: z.string(),
  worktreeId: requiredString('Missing worktree id'),
  branch: requiredString('Missing branch'),
  currentHeadOid: z.string().nullable(),
  executionHostId: z.string().nullable(),
  provider: z.literal('github'),
  linkedPRNumber: z.number().int().positive().nullable(),
  fallbackPRNumber: z.number().int().positive().nullable(),
  fallbackPRSource: z.enum(['explicit', 'pr-cache', 'hosted-review']).nullable(),
  selectionRevision: z.string()
})

export const PRDetailRecoveryStart = z.object({
  clientEpoch: z.object({
    // Bounded before the host allocates anything for it.
    scope: z.string().min(1, 'Missing epoch scope').max(128),
    counter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  }),
  identity: PRDetailRecoveryIdentityParams,
  cacheKey: z.string()
})

export const PRDetailRecoveryWait = z.object({
  ticketId: requiredString('Missing ticket id'),
  afterRevision: z.number().int().nonnegative()
})

export const PRDetailRecoveryCommit = z.object({
  ticketId: requiredString('Missing ticket id'),
  prepareToken: requiredString('Missing prepare token'),
  publicationGrantId: requiredString('Missing publication grant')
})

export const PRDetailRecoveryCancel = z.object({
  ticketId: requiredString('Missing ticket id')
})
