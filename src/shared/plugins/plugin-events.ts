import { z } from 'zod'
import { pluginUiFocusChangedPayloadSchema } from './plugin-focused-surface'
import type { PluginEventName } from './plugin-manifest'
import { pluginWorkspaceAgentContextSchema } from './plugin-host-api'

/**
 * Payload contracts for the v0 plugin event set (worktree lifecycle + agent
 * status + optional UI focus). Payloads are bounded projections — never raw
 * runtime objects — so nothing sensitive (absolute repo paths beyond the
 * worktree's own, remotes, credentials, full tab paths) can leak through
 * the event stream.
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
  agent: pluginWorkspaceAgentContextSchema.nullable().optional()
})

export const PLUGIN_EVENT_PAYLOAD_SCHEMAS: Record<PluginEventName, z.ZodTypeAny> = {
  'worktree.created': worktreeCreatedPayloadSchema,
  'worktree.removed': worktreeRemovedPayloadSchema,
  'agent.status.changed': agentStatusChangedPayloadSchema,
  'ui.focus.changed': pluginUiFocusChangedPayloadSchema
}

export type PluginWorktreeCreatedPayload = z.infer<typeof worktreeCreatedPayloadSchema>
export type PluginWorktreeRemovedPayload = z.infer<typeof worktreeRemovedPayloadSchema>
export type PluginAgentStatusChangedPayload = z.infer<typeof agentStatusChangedPayloadSchema>
export type { PluginUiFocusChangedPayload } from './plugin-focused-surface'
