import * as z from 'zod'

/** Keep lifecycle strings open so newer states do not make persisted rows malformed. */
export const SubagentEntry = z.object({
  id: z.string(),
  label: z.string(),
  state: z.string().min(1),
  tokens: z.number().optional(),
  startedAt: z.number().optional(),
  settledAt: z.number().optional(),
  agentType: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  operation: z.object({ toolName: z.string(), input: z.string().optional() }).optional(),
  lastMessage: z.string().optional()
})
