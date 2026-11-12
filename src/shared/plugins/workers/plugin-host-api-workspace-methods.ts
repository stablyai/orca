import { z } from 'zod'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'
import { PLUGIN_COMMAND_ALIAS_ACTION_IDS } from '../contributions/plugin-command-actions'
import { parseWorkspaceKey } from '../../workspace-scope'
import { spec, WORKER_ONLY } from './plugin-host-method-spec'

/**
 * Orca state and actions a full-access worker cannot reach from Node: its workspaces, terminals
 * and agents. Each runs the runtime method the `orca` CLI runs, on the host that owns the
 * workspace (local, WSL or SSH), so a mod acts exactly as `orca terminal create` would.
 */

/** Provisional release floor for host API 1.7, for plugins that require it in `engines.orca`
 *  instead of checking `host.has`; not a stock-release claim. */
export const PLUGIN_HOST_API_1_7_SINCE = '1.4.258'

export const PLUGIN_WORKSPACE_LIST_LIMIT = 500
export const PLUGIN_PROJECT_LIST_LIMIT = 500
export const PLUGIN_TERMINAL_READ_MAX_LINES = 2000
export const PLUGIN_HOST_ID_MAX_LENGTH = 1024
const ID_MAX = PLUGIN_HOST_ID_MAX_LENGTH
const TEXT_MAX = 4096

export const pluginWorkspaceIdSchema = z.string().min(1).max(ID_MAX)
export const pluginTerminalIdSchema = z.string().min(1).max(ID_MAX)
const workspaceId = pluginWorkspaceIdSchema
const terminalId = pluginTerminalIdSchema

/**
 * The id `workspace.list` gives a workspace: its host-qualified identity when it has one (no path,
 * and it survives the folder moving), else the raw id. Folder workspaces keep their `folder:` key.
 */
export function pluginWorkspaceId(row: { id: string; identityKey?: string | null }): string {
  return row.identityKey && parseWorkspaceKey(row.id)?.type !== 'folder'
    ? `identity:${row.identityKey}`
    : row.id
}

const workspaceListParams = z
  .strictObject({
    /** Also report each workspace's agent and terminal status. Why opt-in: it refreshes every
     *  terminal host. Hosts before 1.7 refuse it with `invalid_params`. */
    includeStatus: z.boolean().optional()
  })
  .optional()
const workspaceStatus = z.object({
  /** `working`: an agent works; `permission`: one waits for input; `done`: an agent finished;
   *  `active`: a live terminal and no agent working; `inactive`: no live terminal. */
  state: z.enum(['working', 'permission', 'done', 'active', 'inactive']),
  /** Output arrived since the person last looked, as the sidebar's dot shows. */
  unread: z.boolean(),
  /** Live terminals. */
  terminalCount: z.number().int().nonnegative(),
  /** Milliseconds since the epoch: the last terminal output, else the last activity; null when none. */
  lastActivityAt: z.number().finite().nullable()
})
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
        /** Its project's (repository's) name, or null when it has none, as for project folders.
         *  Absent before host API 1.5. */
        project: z.string().max(512).nullable().optional(),
        /** The project's id, as `project.list` gives it; null for folders of a project group.
         *  Absent before host API 1.7. */
        projectId: z.string().max(ID_MAX).nullable().optional(),
        /** The path on the host that owns it, which may be WSL or an SSH machine. */
        path: z.string().max(ID_MAX),
        branch: z.string().max(512).nullable(),
        /** The execution host; null for this machine on hosts that do not record one. */
        hostId: z.string().max(ID_MAX).nullable(),
        /** Present only with `includeStatus`, for workspaces Orca has a status for. */
        status: workspaceStatus.optional()
      })
    )
    .max(PLUGIN_WORKSPACE_LIST_LIMIT),
  /** More workspaces exist than the list holds. */
  truncated: z.boolean()
})

const projectListParams = z.strictObject({}).optional()
const projectListResult = z.object({
  projects: z
    .array(
      z.object({
        /** What `workspace.list` rows name as `projectId`. */
        id: z.string().min(1).max(ID_MAX),
        name: z.string().max(512),
        /** `folder`: a plain folder, with no Git repository. */
        kind: z.enum(['git', 'folder']),
        /** The execution host; null for this machine on hosts that do not record one. */
        hostId: z.string().max(ID_MAX).nullable(),
        /** The path on the host that owns it, which may be WSL or an SSH machine. */
        path: z.string().max(ID_MAX)
      })
    )
    .max(PLUGIN_PROJECT_LIST_LIMIT),
  /** More projects exist than the list holds. */
  truncated: z.boolean()
})

const workspaceOpenParams = z.strictObject({ workspaceId })
const workspaceOpenResult = z.object({ opened: z.literal(true) })

export const PLUGIN_WORKSPACE_NAME_MAX = 200
// Characters that are invisible or reorder text: controls, bidi controls, zero-width and
// filler characters, variation selectors, tags and interlinear annotation marks.
const HIDDEN_OR_CONTROL_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff0, 0xfffb],
  [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
]
const isHiddenOrControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0
  return HIDDEN_OR_CONTROL_RANGES.some(([low, high]) => code >= low && code <= high)
}
const workspaceRenameParams = z.strictObject({
  workspaceId,
  /** The name the sidebar shows. It replaces an automatic (branch) name or a person's rename. */
  name: z
    .string()
    .max(PLUGIN_WORKSPACE_NAME_MAX)
    .refine((name) => name.trim().length > 0, 'name must not be blank')
    // A sidebar label is one line of plain text: no control, bidi or invisible characters,
    // which could make it read as another workspace's name.
    .refine((name) => ![...name].some(isHiddenOrControl), 'name must be one line of plain text')
})
const workspaceRenameResult = z.object({ name: z.string() })

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
    summary:
      "Lists every workspace, Git worktrees and folders, on every host Orca reaches; `includeStatus` (host API 1.7) adds each one's agent status.",
    since: 3,
    scope: 'any-workspace',
    capability: 'workspace:read',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: workspaceListParams,
    result: workspaceListResult
  }),
  'project.list': spec({
    summary:
      'Lists your projects (repositories and folders) on every host; `id` is what `workspace.list` rows name as `projectId`.',
    since: 7,
    scope: 'any-workspace',
    capability: 'workspace:read',
    mutation: false,
    surfaces: WORKER_ONLY,
    params: projectListParams,
    result: projectListResult
  }),
  'workspace.open': spec({
    summary:
      'Shows a workspace in Orca, as clicking it in the sidebar does; a folder workspace needs the desktop app.',
    since: 3,
    scope: 'any-workspace',
    capability: 'workspace:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: workspaceOpenParams,
    result: workspaceOpenResult
  }),
  'workspace.rename': spec({
    summary:
      "Renames a workspace in Orca's sidebar, as renaming it by hand does; the name stays until it is renamed again.",
    since: 5,
    scope: 'any-workspace',
    capability: 'workspace:write',
    mutation: true,
    surfaces: WORKER_ONLY,
    params: workspaceRenameParams,
    result: workspaceRenameResult
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
