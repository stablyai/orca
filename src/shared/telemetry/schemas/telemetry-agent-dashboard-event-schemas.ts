import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const agentDashboardSurfaceSchema = lazyZodSchema(() => z.enum(['in_window', 'popout']))
export type AgentDashboardSurface = z.infer<typeof agentDashboardSurfaceSchema>

// No agent, workspace, or card data: adoption only needs the setting transition.
export const agentDashboardEnabledSchema = lazyZodSchema(() =>
  z.object({ enabled: z.boolean() }).strict()
)

// Emitted only after the board React tree mounts, not when an open request is made.
export const agentDashboardOpenedSchema = lazyZodSchema(() =>
  z.object({ surface: agentDashboardSurfaceSchema }).strict()
)

// One visible-use observation per UTC day and surface, capped in main across restarts.
export const agentDashboardActiveSchema = lazyZodSchema(() =>
  z.object({ surface: agentDashboardSurfaceSchema }).strict()
)
