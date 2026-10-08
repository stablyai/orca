import { z } from 'zod'
import type { GitHubPRRefreshReason } from '../github/pull-request-refresh-types'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from './rpc-param-primitives'

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
  headSha: OptionalString
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
