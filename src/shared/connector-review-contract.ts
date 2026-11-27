import * as z from 'zod'
import { lazyZodSchema } from './schema/lazy-zod-schema'
import { CONNECTOR_CLIENT_LIMITS } from './connectors/connector-cloud-contract'

// One inline note on a pull request's diff: a file, a line in its new version (LEFT: the old one),
// and what it says.
export const ConnectorReviewComment = lazyZodSchema(() =>
  z.object({
    path: z.string().min(1).max(CONNECTOR_CLIENT_LIMITS.maxReviewPathLength),
    line: z.number().int().positive(),
    side: z.enum(['LEFT', 'RIGHT']).optional(),
    body: z.string().min(1).max(CONNECTOR_CLIENT_LIMITS.maxReviewCommentChars)
  })
)
export type ConnectorReviewComment = z.infer<typeof ConnectorReviewComment>

export const ConnectorReview = lazyZodSchema(() =>
  z.object({
    comments: z.array(ConnectorReviewComment).min(1).max(CONNECTOR_CLIENT_LIMITS.maxReviewComments)
  })
)
export type ConnectorReview = z.infer<typeof ConnectorReview>
