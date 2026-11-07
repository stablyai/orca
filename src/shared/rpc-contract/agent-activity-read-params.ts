import { z } from 'zod'

export const AgentActivitySubjectSchema = z.object({
  paneKey: z.string().min(1).max(2048),
  worktreeId: z.string().min(1).max(8192),
  hostId: z.string().min(1).max(2048),
  latestActivityAt: z.number().finite().nonnegative(),
  stateStartedAt: z.number().finite().nonnegative()
})

export const SetAgentActivityReadStateParams = AgentActivitySubjectSchema.omit({
  stateStartedAt: true
})
  .extend({ read: z.boolean() })
  .strict()

export const AgentActivityReadStateSchema = AgentActivitySubjectSchema.extend({
  unread: z.boolean()
})
export const AgentActivityReadSnapshotSchema = z.object({
  available: z.boolean(),
  activities: z.array(AgentActivityReadStateSchema)
})
