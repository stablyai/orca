import { z } from 'zod'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
import { OptionalString, requiredString } from '../rpc-param-primitives'
import { FullGitObjectId } from '../source-control/git-params'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const UpdatePrTitle = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    title: requiredString('Missing title'),
    prRepo: SlugRepo.nullable().optional()
  })
)

export const UpdatePr = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    updates: z.object({
      title: OptionalString,
      body: z.string().optional()
    }),
    prRepo: SlugRepo.nullable().optional()
  })
)

/** `expectedHeadSha`: the PR head the client reviewed; older hosts drop it and merge unfenced. */
export const MergePr = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    method: z.enum(['merge', 'squash', 'rebase']).optional(),
    prRepo: SlugRepo.nullable().optional(),
    expectedHeadSha: FullGitObjectId.transform((sha) => sha.toLowerCase())
      .nullable()
      .optional()
  })
)

export const SetPrAutoMerge = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    enabled: z.boolean(),
    method: z.enum(['merge', 'squash', 'rebase']).optional(),
    prRepo: SlugRepo.nullable().optional()
  })
)

export const UpdatePrState = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    prRepo: SlugRepo.nullable().optional(),
    updates: z.object({
      state: z.enum(['open', 'closed'])
    })
  })
)

export const MarkPrReadyForReview = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    prRepo: SlugRepo.nullable().optional()
  })
)

export const MarkPrDraft = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    prRepo: SlugRepo.nullable().optional()
  })
)

export const RequestPrReviewers = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    prRepo: SlugRepo.nullable().optional(),
    reviewers: z.array(z.string()).min(1)
  })
)

export const RemovePrReviewers = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    prRepo: SlugRepo.nullable().optional(),
    reviewers: z.array(z.string()).min(1)
  })
)

export const PRReviewComment = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    prRepo: SlugRepo.nullable().optional(),
    commitId: requiredString('Missing PR head SHA'),
    path: requiredString('File path required'),
    line: z.number().int().positive(),
    startLine: z.number().int().positive().optional(),
    body: requiredString('Comment body required')
  })
)

export const PRReviewCommentReply = lazyZodSchema(() =>
  RepoSelector.extend({
    prNumber: z.number().int().positive(),
    commentId: z.number().int().positive(),
    body: requiredString('Comment body required'),
    threadId: OptionalString,
    path: OptionalString,
    line: z.number().int().positive().optional(),
    prRepo: SlugRepo.nullable().optional()
  })
)
