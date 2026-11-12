import { z } from 'zod'
import { RESUMABLE_TUI_AGENTS } from '../../agent-session/lifecycle/agent-session-resume'
import { pluginAgentSessionIdSchema } from './plugin-host-api-panel-methods'
import { pluginResumeKey } from './plugin-agent-resume-key'
import {
  PLUGIN_HOST_ID_MAX_LENGTH,
  PLUGIN_HOST_TEXT_MAX_LENGTH,
  isPluginPlainLine,
  pluginAgentSchema,
  pluginLabelNameSchema,
  pluginTerminalIdSchema,
  pluginWorkspaceIdSchema
} from './plugin-host-api-workspace-methods'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/** Host API 1.8: create workspaces and resume agents, as `orca worktree create` and a resume do. */

const workspaceCreateParams = z
  .strictObject({
    /** The project, as `project.list` gives its id. */
    projectId: z.string().min(1).max(PLUGIN_HOST_ID_MAX_LENGTH),
    /** The project's host, as `project.list` gives it; needed only when two hosts have it. */
    hostId: z.string().min(1).max(PLUGIN_HOST_ID_MAX_LENGTH).optional(),
    /** The workspace's name, which its branch takes too; Orca picks one when absent. */
    name: pluginLabelNameSchema.optional(),
    /** The branch or ref to start from; the project's default when absent. */
    baseBranch: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (ref) => !ref.startsWith('-') && !/\s/.test(ref) && isPluginPlainLine(ref),
        'baseBranch must be a branch or ref name'
      )
      .optional(),
    /** Starts this agent in the new workspace once its setup has run; also needs `agent:launch`. */
    agent: pluginAgentSchema.optional(),
    /** Sent to `agent` as its first message. */
    prompt: z.string().min(1).max(PLUGIN_HOST_TEXT_MAX_LENGTH).optional(),
    /** `skip`: create it without the project's setup script. Absent: setup runs as the project's
     *  settings say, and a project set to ask is refused. */
    setup: z.literal('skip').optional(),
    /** Shows the new workspace in Orca's window; default false. */
    open: z.boolean().optional()
  })
  .refine((params) => params.prompt === undefined || params.agent !== undefined, {
    message: 'prompt requires agent',
    path: ['prompt']
  })
const workspaceCreateResult = z.object({
  /** The id `workspace.list` gives the new workspace. */
  workspaceId: pluginWorkspaceIdSchema,
  /** The agent's terminal, when `agent` was given. */
  terminalId: pluginTerminalIdSchema.optional()
})

const agentResumeParams = z.strictObject({
  workspaceId: pluginWorkspaceIdSchema,
  /** The agent that ran the session; agents that resume from a transcript file are refused. */
  agent: z
    .enum(RESUMABLE_TUI_AGENTS)
    .refine((agent) => pluginResumeKey(agent) !== null, 'this agent cannot resume by session id'),
  /** The session, as `agents.list` and `agent.status.changed` give its `sessionId`. */
  sessionId: pluginAgentSessionIdSchema
})
const agentResumeResult = z.object({
  /** The terminal the session runs in, as `terminal.read` and `terminal.sendText` take it. */
  terminalId: pluginTerminalIdSchema,
  /** False when an Orca terminal already ran this session; `terminalId` is that terminal. */
  started: z.boolean()
})

export const PLUGIN_WORKSPACE_CREATE_API = {
  'workspace.create': spec({
    summary:
      "Creates a workspace (a new branch and worktree) in a Git project, local or SSH, and returns its id; with `agent`, starts that agent there once setup has run, in the background unless `open`. Orca's workspace-create and agent hooks run as for any create.",
    since: 8,
    scope: 'any-workspace',
    capability: 'workspace:create',
    paramCapabilities: { agent: 'agent:launch' },
    mutation: true,
    surfaces: WORKER_ONLY,
    params: workspaceCreateParams,
    result: workspaceCreateResult
  }),
  'agent.resume': spec({
    summary:
      "Resumes an agent's earlier session by its `sessionId` in a new terminal of a workspace, in the background; `started` is false when an Orca terminal already runs it. In WSL it uses the distro's default agent account, as `agent.launch` does.",
    since: 8,
    scope: 'any-workspace',
    capability: 'agent:launch',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: agentResumeParams,
    result: agentResumeResult
  })
}
