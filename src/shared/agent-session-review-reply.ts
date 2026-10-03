// What "Resolve comments with AI" asks Orca to do on the review once the agent takes the launch
// prompt: resolve the threads the host can close, and post Orca's "fixing" reply on the ones it
// cannot (GitHub only). It rides the message, so whichever host records the message runs it.

import { z } from 'zod'

/** Bounds a spec so a message cannot carry an unbounded side effect. */
export const MAX_REVIEW_REPLY_TARGETS = 500
export const MAX_REVIEW_REPLY_BYTES = 64 * 1024

const Id = z.string().min(1).max(512)

const GitHubThreadReply = z
  .object({
    commentId: z.number().int().positive(),
    threadId: Id.optional(),
    path: z.string().min(1).max(4096).optional(),
    line: z.number().int().positive().optional()
  })
  .strict()

const GitHubReviewReply = z
  .object({
    provider: z.literal('github'),
    repoId: Id,
    prNumber: z.number().int().positive(),
    prRepo: z.object({ owner: Id, repo: Id, host: Id.optional() }).strict().optional(),
    /** Review threads to resolve. */
    resolve: z.array(Id).max(MAX_REVIEW_REPLY_TARGETS),
    /** In-thread replies, each posting `replyBody` under its comment. */
    replies: z.array(GitHubThreadReply).max(MAX_REVIEW_REPLY_TARGETS),
    replyBody: z.string().min(1).max(4096),
    /** One PR conversation comment for every selected comment with no reply endpoint. */
    conversationReply: z.string().min(1).max(MAX_REVIEW_REPLY_BYTES).optional()
  })
  .strict()

const GitLabReviewReply = z
  .object({
    provider: z.literal('gitlab'),
    repoId: Id,
    iid: z.number().int().positive(),
    /** Merge request discussions to resolve. */
    resolve: z.array(Id).max(MAX_REVIEW_REPLY_TARGETS)
  })
  .strict()

export const AgentSessionReviewReplySchema = z
  .discriminatedUnion('provider', [GitHubReviewReply, GitLabReviewReply])
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_REVIEW_REPLY_BYTES,
    'Review reply is too large'
  )

export type AgentSessionReviewReply = z.infer<typeof AgentSessionReviewReplySchema>

/** `{ reviewReply }` for a well-formed stored spec, else nothing: for spreading into a copy. */
export function agentSessionReviewReplyField(value: unknown): {
  reviewReply?: AgentSessionReviewReply
} {
  const reviewReply = readAgentSessionReviewReply(value)
  return reviewReply ? { reviewReply } : {}
}

/** A stored spec as a reader meets it; undefined for anything malformed, which then runs nothing. */
export function readAgentSessionReviewReply(value: unknown): AgentSessionReviewReply | undefined {
  const parsed = AgentSessionReviewReplySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
