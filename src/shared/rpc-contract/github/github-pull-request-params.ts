import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import type { GitHubPRRefreshReason } from '../../github/pull-requests/refresh/pull-request-refresh-types'
import { OptionalGhAccountExpectation, RepoSelector, SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from '../rpc-param-primitives'

export const OptionalPRRefreshReason = lazyZodSchema(() =>
  z
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
)

export const PrForBranch = lazyZodSchema(() =>
  RepoSelector.extend({
    branch: requiredString('Missing branch'),
    reason: OptionalPRRefreshReason,
    userRefresh: z.boolean().optional(),
    acceptRevalidationOnly: z.boolean().optional(),
    selected: z.boolean().optional(),
    linkedPRNumber: z.number().int().positive().nullable().optional(),
    linkedPRUrl: z.string().max(4096).optional(),
    fallbackPRNumber: z.number().int().positive().nullable().optional(),
    acceptMergedFallbackPR: z.boolean().optional(),
    currentHeadOid: z.string().nullable().optional()
  })
)

export const PullRequest = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    noCache: z.boolean().optional(),
    prRepo: SlugRepo.nullable().optional()
  })
)

export const PRCommentReaction = lazyZodSchema(() =>
  RepoSelector.extend({
    reactionSubjectId: requiredString('Missing reaction subject ID'),
    content: z.enum(['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes']),
    reacted: z.boolean(),
    prRepo: SlugRepo.nullable().optional()
  })
)

export const PullRequestChecks = lazyZodSchema(() =>
  PullRequest.extend({
    headSha: OptionalString,
    userRefresh: z.boolean().optional(),
    /** `swr`: a client's timer; the host's PR auto-refresh cadence may answer from its last read. */
    reason: OptionalPRRefreshReason
  })
)

export const PullRequestCheckDetails = lazyZodSchema(() =>
  RepoSelector.extend({
    checkRunId: z.number().int().positive().optional(),
    workflowRunId: z.number().int().positive().optional(),
    checkName: OptionalString,
    url: OptionalString.nullable().optional(),
    prRepo: SlugRepo.nullable().optional()
  })
)

export const RerunPullRequestChecks = lazyZodSchema(() =>
  PullRequest.extend({
    headSha: OptionalString,
    failedOnly: z.boolean().optional()
  })
)

export const PullRequestFileContents = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    prRepo: SlugRepo.nullable().optional(),
    path: requiredString('Missing file path'),
    oldPath: OptionalString,
    status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
    headSha: requiredString('Missing head SHA'),
    baseSha: requiredString('Missing base SHA')
  })
)

export const PullRequestFileViewed = lazyZodSchema(() =>
  RepoSelector.extend({
    expectedGhAccount: OptionalGhAccountExpectation,
    prRepo: SlugRepo.nullable().optional(),
    pullRequestId: requiredString('Missing pull request ID'),
    path: requiredString('Missing file path'),
    viewed: z.boolean()
  })
)

export const ReviewThread = lazyZodSchema(() =>
  RepoSelector.extend({
    prRepo: SlugRepo.nullable().optional(),
    threadId: requiredString('Missing thread ID'),
    resolve: z.boolean()
  })
)
