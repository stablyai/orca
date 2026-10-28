import { z } from 'zod'

export const WORKTREE_REVIEW_LEASE_MS = 120_000
export const WorktreeReviewStatusSchema = z.object({
  type: z.enum(['snapshot', 'updated']),
  subscriptionId: z.string(),
  worktreeId: z.string(),
  branch: z.string(),
  review: z
    .object({
      number: z.number(),
      state: z.enum(['open', 'draft', 'closed', 'merged']),
      checksStatus: z.enum(['success', 'failure', 'pending', 'neutral']),
      title: z.string(),
      url: z.string()
    })
    .nullable(),
  fetchedAt: z.number().nullable(),
  stale: z.boolean(),
  error: z.string().optional()
})
export type WorktreeReviewStatus = z.infer<typeof WorktreeReviewStatusSchema>
