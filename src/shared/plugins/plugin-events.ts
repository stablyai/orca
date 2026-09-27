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
  /** The combined status the user sees: `working` while the main agent or any live child works. */
  state: z.string().min(1).max(256),
  receivedAt: z.number().finite().positive(),
  /** The main agent's own state beside the combined one, so a plugin can tell "the main agent is
   *  still working" from "a subagent still runs after the main agent finished". Absent from hosts that
   *  predate it and from rows with no main agent fact; `state` keeps its meaning either way. */
  mainAgent: z
    .object({
      state: z.string().min(1).max(256),
      /** The provider's verdict on the main agent's last finished turn; present only while `state` is done. */
      outcome: z.string().min(1).max(256).optional(),
      // Why: the same bound the row normalizer applies; a stricter one here would reject the whole event.
      /** Stamped by the host the agent runs on (an SSH host's own clock), unlike `receivedAt`. */
      stateStartedAt: z.number().finite()
    })
    .optional()
})

export const PLUGIN_EVENT_PAYLOAD_SCHEMAS: Record<PluginEventName, z.ZodTypeAny> = {
  'worktree.created': worktreeCreatedPayloadSchema,
  'worktree.removed': worktreeRemovedPayloadSchema,
  'agent.status.changed': agentStatusChangedPayloadSchema
}

export type PluginWorktreeCreatedPayload = z.infer<typeof worktreeCreatedPayloadSchema>
export type PluginWorktreeRemovedPayload = z.infer<typeof worktreeRemovedPayloadSchema>
export type PluginAgentStatusChangedPayload = z.infer<typeof agentStatusChangedPayloadSchema>
