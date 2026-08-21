import { z } from 'zod'
import type { PluginEventName } from './plugin-manifest'

/**
 * Payload contracts for the v0 plugin event set (worktree lifecycle + agent
 * status only). Payloads are bounded projections — never raw runtime
 * objects — so nothing sensitive (absolute repo paths beyond the worktree's
 * own, remotes, credentials) can leak through the event stream.
 */

export const worktreeCreatedPayloadSchema = z.object({
  worktreeId: z.string().min(1).max(2048),
  path: z
    .string()
    .min(1)
    .max(32 * 1024),
  branch: z.string().max(1024)
})

export const worktreeRemovedPayloadSchema = z.object({
  worktreeId: z.string().min(1).max(2048),
  path: z
    .string()
    .min(1)
    .max(32 * 1024)
})

export const agentStatusChangedPayloadSchema = z.object({
  worktreeId: z.string().min(1).max(2048).nullable(),
  paneKey: z.string().min(1).max(2048),
  state: z.string().min(1).max(256),
  receivedAt: z.number().finite().positive(),
  // Why (#15639): several agents can share one worktree, and paneKey alone
  // cannot name WHICH session changed. The provider's own session id and
  // transcript path are already captured on the status entry; surface them so
  // plugins correlate without guessing by transcript mtime. Optional because
  // not every agent CLI reports a session on every status event.
  sessionId: z.string().min(1).max(2048).optional(),
  transcriptPath: z.string().min(1).max(4096).optional()
})

export const PLUGIN_EVENT_PAYLOAD_SCHEMAS: Record<PluginEventName, z.ZodTypeAny> = {
  'worktree.created': worktreeCreatedPayloadSchema,
  'worktree.removed': worktreeRemovedPayloadSchema,
  'agent.status.changed': agentStatusChangedPayloadSchema
}

export type PluginWorktreeCreatedPayload = z.infer<typeof worktreeCreatedPayloadSchema>
export type PluginWorktreeRemovedPayload = z.infer<typeof worktreeRemovedPayloadSchema>
export type PluginAgentStatusChangedPayload = z.infer<typeof agentStatusChangedPayloadSchema>
