import { z } from 'zod'
import type { PluginEventName } from './manifest/plugin-manifest'

/**
 * Payload contracts for the v0 plugin event set (workspace lifecycle + agent
 * status only). Payloads are bounded projections — never raw runtime
 * objects — so nothing sensitive (absolute repo paths beyond the worktree's
 * own, remotes, credentials) can leak through the event stream.
 */

/** Plugins see `main`, not the `refs/heads/main` Orca tracks internally. */
export function shortPluginBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

const workspaceIdentity = {
  workspaceId: z.string().min(1).max(2048),
  /** Folder workspaces have no branch; only worktrees emit lifecycle events today. */
  kind: z.enum(['worktree', 'folder'])
}

export const workspaceCreatedPayloadSchema = z.object({
  ...workspaceIdentity,
  path: z
    .string()
    .min(1)
    .max(32 * 1024),
  branch: z.string().max(1024)
})

export const workspaceRemovedPayloadSchema = z.object({
  ...workspaceIdentity,
  path: z
    .string()
    .min(1)
    .max(32 * 1024)
})

export const agentStatusChangedPayloadSchema = z.object({
  workspaceId: z.string().min(1).max(2048).nullable(),
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
      /** The verdict on the main agent's last finished turn, the provider's or else the host-observed end
       *  (`interruption`, `unconfirmed`); present only while `state` is done. */
      outcome: z.string().min(1).max(256).optional(),
      // Why: the same bound the row normalizer applies; a stricter one here would reject the whole event.
      /** Stamped by the host the agent runs on (an SSH host's own clock), unlike `receivedAt`. */
      stateStartedAt: z.number().finite()
    })
    .optional()
})

export const PLUGIN_EVENT_PAYLOAD_SCHEMAS: Record<PluginEventName, z.ZodTypeAny> = {
  'workspace.created': workspaceCreatedPayloadSchema,
  'workspace.removed': workspaceRemovedPayloadSchema,
  'agent.status.changed': agentStatusChangedPayloadSchema
}

export type PluginWorkspaceCreatedPayload = z.infer<typeof workspaceCreatedPayloadSchema>
export type PluginWorkspaceRemovedPayload = z.infer<typeof workspaceRemovedPayloadSchema>
export type PluginAgentStatusChangedPayload = z.infer<typeof agentStatusChangedPayloadSchema>
