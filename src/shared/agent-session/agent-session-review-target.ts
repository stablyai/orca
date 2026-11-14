import * as z from 'zod'

export const AgentSessionReviewTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('uncommittedChanges') }),
  z.object({ type: z.literal('baseBranch'), branch: z.string().trim().min(1) }),
  z.object({
    type: z.literal('commit'),
    sha: z.string().trim().min(1),
    title: z.string().optional()
  }),
  z.object({ type: z.literal('custom') })
])
export type AgentSessionReviewTarget = z.infer<typeof AgentSessionReviewTargetSchema>
