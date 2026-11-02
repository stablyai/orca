import { z } from 'zod'
import { isTuiAgent } from '../../tui-agent-config'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from '../contributions/plugin-command-actions'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/**
 * Orca state and actions a full-access worker cannot reach from Node: its workspaces, terminals
 * and agents. Each runs the runtime method the `orca` CLI runs, on the host that owns the
 * workspace (local, WSL or SSH), so a mod acts exactly as `orca terminal create` would.
 */

export const PLUGIN_WORKSPACE_LIST_LIMIT = 500
export const PLUGIN_TERMINAL_READ_MAX_LINES = 2000
const ID_MAX = 1024
const TEXT_MAX = 4096

const workspaceId = z.string().min(1).max(ID_MAX)
const terminalId = z.string().min(1).max(ID_MAX)

const workspaceListParams = z.strictObject({}).optional()
const workspaceListResult = z.object({
  workspaces: z
    .array(
      z.object({
        /** What every other workspace method takes; it names the host too, so a workspace that two
         *  hosts both have is never ambiguous. */
        id: workspaceId,
        /** `folder`: a plain folder, with no Git branch. */
        kind: z.enum(['worktree', 'folder']),
        name: z.string().max(512),
        /** The path on the host that owns it, which may be WSL or an SSH machine. */
        path: z.string().max(ID_MAX),
        branch: z.string().max(512).nullable(),
        /** The execution host; null for this machine on hosts that do not record one. */
        hostId: z.string().max(ID_MAX).nullable()
      })
    )
    .max(PLUGIN_WORKSPACE_LIST_LIMIT),
  /** More workspaces exist than the list holds. */
  truncated: z.boolean()
})

const workspaceOpenParams = z.strictObject({ workspaceId })
const workspaceOpenResult = z.object({ opened: z.literal(true) })

const terminalCreateParams = z.strictObject({
  workspaceId,
  title: z.string().min(1).max(512).optional(),
  /** Run in the new terminal's shell once it starts. */
  command: z.string().min(1).max(TEXT_MAX).optional()
})
const terminalCreateResult = z.object({ terminalId })

const terminalReadParams = z.strictObject({
  terminalId,
  /** The newest lines to return; default 200. */
  maxLines: z.number().int().min(1).max(PLUGIN_TERMINAL_READ_MAX_LINES).optional()
})
const terminalReadResult = z.object({
  /** Plain text, oldest first, without escape sequences. */
  lines: z.array(z.string()).max(PLUGIN_TERMINAL_READ_MAX_LINES),
  /** Older output exists beyond `lines`. */
  truncated: z.boolean()
})

const agentLaunchParams = z.strictObject({
  workspaceId,
  /** An agent Orca knows: `claude`, `codex`, `gemini`, ... */
  agent: z.string().min(1).max(64).refine(isTuiAgent, 'unknown agent'),
  /** Sent to the agent as its first message. */
  prompt: z.string().min(1).max(TEXT_MAX).optional()
})
const agentLaunchResult = z.object({
  /** The agent's terminal, as `terminal.read` and `terminal.sendText` take it. */
  terminalId
})

/** A `/`-separated path inside the workspace: not absolute, no `..`, no drive letter. */
export function isPluginWorkspaceRelativePath(path: string): boolean {
  const segments = path.split(/[\\/]/)
  return (
    !/^[a-z]:/i.test(path) &&
    segments[0] !== '' &&
    segments.every((segment) => segment !== '..') &&
    segments.some((segment) => segment !== '' && segment !== '.')
  )
}

const editorOpenParams = z.strictObject({
  workspaceId,
  /** Relative to the workspace, `/`-separated; it must stay inside it. */
  path: z
    .string()
    .min(1)
    .max(ID_MAX)
    .refine(isPluginWorkspaceRelativePath, 'path must be relative and inside the workspace')
})
const editorOpenResult = z.object({ opened: z.literal(true) })

const commandsRunParams = z.strictObject({
  /** A built-in action, the same list `contributes.commands[].action` takes. */
  action: z.enum(PLUGIN_COMMAND_ALIAS_ACTION_IDS)
})
const commandsRunResult = z.object({ ran: z.literal(true) })

export const PLUGIN_WORKSPACE_ACTIONS_API = {
  'workspace.list': spec({
    summary: 'Lists every workspace, Git worktrees and folders, on every host Orca reaches.',
    since: 3,
    scope: 'any-workspace',
    capability: 'workspace:read',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: workspaceListParams,
    result: workspaceListResult
  }),
  'workspace.open': spec({
    summary: 'Shows a workspace in Orca, as clicking it in the sidebar does.',
    since: 3,
    scope: 'any-workspace',
    capability: 'workspace:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: workspaceOpenParams,
    result: workspaceOpenResult
  }),
  'terminal.create': spec({
    summary: 'Opens a terminal in a workspace, optionally running a command, in the background.',
    since: 3,
    scope: 'any-workspace',
    capability: 'terminal:send',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: terminalCreateParams,
    result: terminalCreateResult
  }),
  'terminal.read': spec({
    summary: `Reads a terminal's newest output as plain text, at most ${PLUGIN_TERMINAL_READ_MAX_LINES} lines.`,
    since: 3,
    scope: 'explicit-terminal',
    capability: 'terminal:read',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: terminalReadParams,
    result: terminalReadResult
  }),
  'agent.launch': spec({
    summary:
      "Starts an agent's CLI in a new terminal of a workspace, in the background, and returns as soon as it starts; a `prompt` is sent once the agent is ready.",
    since: 3,
    scope: 'any-workspace',
    capability: 'agent:launch',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: agentLaunchParams,
    result: agentLaunchResult
  }),
  'editor.open': spec({
    summary:
      "Opens a file of a workspace in an editor tab of Orca's window; desktop app only. `workspace.open` shows the workspace.",
    since: 3,
    scope: 'any-workspace',
    capability: 'workspace:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: editorOpenParams,
    result: editorOpenResult
  }),
  'commands.run': spec({
    summary:
      "Runs one of Orca's built-in actions in its window, never a plugin's replacement of it; desktop app only.",
    since: 3,
    scope: 'desktop',
    capability: 'workspace:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: commandsRunParams,
    result: commandsRunResult
  })
}
