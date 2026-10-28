import { z } from 'zod'

export const WorktreeReviewSubscribe = z.object({ worktree: z.string().min(1) })
export const WorktreeReviewSubscription = z.object({ subscriptionId: z.string().min(1) })
