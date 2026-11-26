import { z } from 'zod'

export const agentDashboardSurfaceSchema = z.enum(['in_window', 'popout'])
export type AgentDashboardSurface = z.infer<typeof agentDashboardSurfaceSchema>

// No agent, workspace, or card data: adoption only needs the setting transition.
export const agentDashboardEnabledSchema = z.object({ enabled: z.boolean() }).strict()

// Emitted only after the board React tree mounts, not when an open request is made.
export const agentDashboardOpenedSchema = z
  .object({ surface: agentDashboardSurfaceSchema })
  .strict()

// One visible-use observation per UTC day and surface, capped in main across restarts.
export const agentDashboardActiveSchema = z
  .object({ surface: agentDashboardSurfaceSchema })
  .strict()
