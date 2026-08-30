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
  /** Provider-owned session id, when the pane has one.
   *  Why: `paneKey` is `<tabId>:<layoutLeaf>` and carries no session identity, so a plugin seeing
   *  two panes in one worktree cannot tell which agent transitioned — and several agents per
   *  worktree is the common case. This is the id only, never `providerSession.transcriptPath`:
   *  correlation needs a stable distinct token, not a filesystem path, so the payload stays a
   *  bounded projection. Nullable and optional, so existing subscribers are unaffected. */
  sessionId: z.string().min(1).max(2048).nullable().optional()
})

export const PLUGIN_EVENT_PAYLOAD_SCHEMAS: Record<PluginEventName, z.ZodTypeAny> = {
  'worktree.created': worktreeCreatedPayloadSchema,
  'worktree.removed': worktreeRemovedPayloadSchema,
  'agent.status.changed': agentStatusChangedPayloadSchema
}

export type PluginWorktreeCreatedPayload = z.infer<typeof worktreeCreatedPayloadSchema>
export type PluginWorktreeRemovedPayload = z.infer<typeof worktreeRemovedPayloadSchema>
export type PluginAgentStatusChangedPayload = z.infer<typeof agentStatusChangedPayloadSchema>
