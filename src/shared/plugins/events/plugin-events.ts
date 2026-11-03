import { z } from 'zod'
import { AGENT_STATUS_STATES } from '../../agent-status-types'
import { AGENT_TURN_OUTCOMES } from '../../agent-turn-outcome'
import type { PluginEventName } from '../manifest/plugin-manifest'
import {
  PLUGIN_TERMINAL_ID_MAX_LENGTH,
  PLUGIN_WORKSPACE_LABEL_MAX_LENGTH,
  pluginWorkspaceContextSchema
} from '../workers/plugin-host-api'

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
  /** The pane's terminal, as `workspace.readContext` and `terminal.sendText` name it; absent when
   *  Orca cannot tie the pane to a terminal it lists. */
  terminalId: z.string().min(1).max(PLUGIN_TERMINAL_ID_MAX_LENGTH).optional(),
  /** The pane's name, or its terminal title. */
  title: z.string().max(PLUGIN_WORKSPACE_LABEL_MAX_LENGTH).optional(),
  /** The combined status the user sees: `working` while the main agent or any live child works. */
  state: z.enum(AGENT_STATUS_STATES),
  receivedAt: z.number().finite().positive(),
  /** Distinguish the main agent from combined child activity; absent on older hosts or without main-agent evidence. State keeps its meaning. */
  mainAgent: z
    .object({
      state: z.enum(AGENT_STATUS_STATES),
      /** The verdict on the main agent's last finished turn, the provider's or else the host-observed end
       *  (`interruption`, `unconfirmed`); present only while `state` is done. */
      outcome: z.enum(AGENT_TURN_OUTCOMES).optional(),
      // Why: the same bound the row normalizer applies; a stricter one here would reject the whole event.
      /** Stamped by the host the agent runs on (an SSH host's own clock), unlike `receivedAt`. */
      stateStartedAt: z.number().finite()
    })
    .optional()
})

export const workspaceChangedPayloadSchema = z.object({
  /** What `workspace.readContext` answers now; null when no workspace is focused. */
  context: pluginWorkspaceContextSchema
})

export const PLUGIN_EVENT_PAYLOAD_SCHEMAS = {
  'workspace.created': workspaceCreatedPayloadSchema,
  'workspace.removed': workspaceRemovedPayloadSchema,
  'agent.status.changed': agentStatusChangedPayloadSchema,
  'workspace.changed': workspaceChangedPayloadSchema
} satisfies Record<PluginEventName, z.ZodType>

/** One line per event for the generated reference and author typings. */
export const PLUGIN_EVENT_SUMMARIES: Record<PluginEventName, string> = {
  'workspace.created': 'A worktree workspace was created.',
  'workspace.removed': 'A worktree workspace was removed.',
  'agent.status.changed':
    'An agent in a terminal pane changed status; `workspaceId` is null when Orca cannot tie the pane to a workspace, and `terminalId` names its terminal when Orca lists it.',
  'workspace.changed':
    'The focused workspace changed, or its terminals were opened, closed or renamed; `context` is what `workspace.readContext` now answers. Each new subscriber first gets the current context.'
}

export type PluginEventPayload<E extends PluginEventName> = z.infer<
  (typeof PLUGIN_EVENT_PAYLOAD_SCHEMAS)[E]
>

export type PluginAgentStatusChangedPayload = z.infer<typeof agentStatusChangedPayloadSchema>
