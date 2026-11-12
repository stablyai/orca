import { z } from 'zod'
import { pluginAgentSessionIdSchema } from './plugin-host-api-panel-methods'
import {
  PLUGIN_HOST_ID_MAX_LENGTH,
  pluginWorkspaceIdSchema
} from './plugin-host-api-workspace-methods'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/** Host API 1.9: the agent sessions Orca's Agent Session History lists on this computer. */

export const PLUGIN_AGENT_SESSION_LIST_LIMIT = 200
export const PLUGIN_AGENT_SESSION_LIST_DEFAULT = 50
export const PLUGIN_AGENT_SESSION_TITLE_MAX = 512

const agentListSessionsParams = z
  .strictObject({
    /** Only this workspace's sessions, as `workspace.list` gives its id. */
    workspaceId: pluginWorkspaceIdSchema.optional(),
    /** At most this many, newest first; default 50. */
    limit: z.number().int().min(1).max(PLUGIN_AGENT_SESSION_LIST_LIMIT).optional()
  })
  .optional()
const agentListSessionsResult = z.object({
  sessions: z
    .array(
      z.object({
        /** What `agent.resume` takes. */
        sessionId: pluginAgentSessionIdSchema,
        /** Which agent ran it (`claude`, `codex`, ...). */
        agent: z.string().max(128),
        /** The session's name, or a stand-in such as the start of its first message. */
        title: z.string().max(PLUGIN_AGENT_SESSION_TITLE_MAX),
        /** The workspace it ran in, as `workspace.list` gives its id; null when none of this
         *  computer's workspaces holds the folder it ran in. */
        workspaceId: pluginWorkspaceIdSchema.nullable(),
        /** The host whose history lists it: `local` for this computer. */
        hostId: z.string().max(PLUGIN_HOST_ID_MAX_LENGTH),
        branch: z.string().max(512).nullable(),
        /** Milliseconds since the epoch; null when the session does not record it. */
        createdAt: z.number().finite().nullable(),
        /** Milliseconds since the epoch: its last activity. */
        updatedAt: z.number().finite(),
        messageCount: z.number().int().nonnegative(),
        totalTokens: z.number().int().nonnegative(),
        /** An Orca terminal runs it now. */
        running: z.boolean()
      })
    )
    .max(PLUGIN_AGENT_SESSION_LIST_LIMIT),
  /** More sessions match than were returned. */
  truncated: z.boolean()
})

export const PLUGIN_AGENT_HISTORY_API = {
  'agent.listSessions': spec({
    summary:
      "Past agent sessions in Orca's Agent Session History on this computer, newest first: title, agent, workspace, branch, times, message and token counts, and whether a terminal runs it. Never the conversation or file paths, though a title can be the start of its first message. `agent.resume` resumes one by its `sessionId`, for agents that resume by id.",
    since: 9,
    scope: 'any-workspace',
    capability: 'history:read',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: agentListSessionsParams,
    result: agentListSessionsResult
  })
}
