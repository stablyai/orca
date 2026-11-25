// The MCP servers a host gives its agents' sessions: one list per host, kept beside bot tools in the
// same file format, with which agents and workspaces each server is on for.
import * as z from 'zod'
import type { BotToolSignInStatus } from '../bot-tool-sign-in'
import { isFloatingWorkspaceId } from '../workspace/identity/floating-workspace-worktree'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../workspace/identity/workspace-scope'
import { getRepoIdFromWorktreeId } from '../worktree/id'

// Host advertises mcpServers.* only while its MCP servers switch is on; clients hide the feature otherwise.
export const MCP_SERVERS_RUNTIME_CAPABILITY = 'mcp-servers.v1' as const

/** An agent's id as the host names it (claude, codex…); loose, so a newer client's agents pass. */
export const MCP_SERVER_AGENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * A repo id, or `folder:<id>` for a folder workspace: never a worktree id (`<repo>::<path>`), so a
 * choice holds for every worktree of the repo.
 */
export const McpServerWorkspaceKey = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (key) => !key.includes('::') && !key.startsWith('worktree:'),
    'Name a repo or folder workspace, not a worktree'
  )

/**
 * Where a server is on: a workspace in `on` has it, one in `off` doesn't, and any other (one added
 * later) follows `later`. "All workspaces" is `{ later: true, on: [], off: [] }`.
 */
export const McpServerWorkspacesSchema = z
  .strictObject({
    later: z.boolean(),
    on: z.array(McpServerWorkspaceKey).max(1000),
    off: z.array(McpServerWorkspaceKey).max(1000)
  })
  .refine(
    (workspaces) => !workspaces.on.some((key) => workspaces.off.includes(key)),
    'A workspace is either on or off'
  )
export type McpServerWorkspaces = z.infer<typeof McpServerWorkspacesSchema>

export const ALL_MCP_SERVER_WORKSPACES: McpServerWorkspaces = { later: true, on: [], off: [] }

/** The agents whose terminal CLI reads only its own MCP file, so Orca keeps its servers there. */
export const MCP_FILE_AGENTS = ['grok', 'cursor', 'droid'] as const
export type McpFileAgent = (typeof MCP_FILE_AGENTS)[number]
/** Per agent, whether the user let Orca keep its servers in that agent's file. */
export type McpAgentFiles = Record<McpFileAgent, boolean>

/** Why no server from Orca reaches an agent's sessions, whichever server it is. */
export type McpAgentProblem = {
  /** `blocked`: the agent's own (organization) settings refuse them; `terminal-off`: its terminal
   *  sessions can't take them. */
  kind: 'blocked' | 'terminal-off'
  detail: string
}

/** What mcpServers.list answers. */
export type McpHostList = {
  servers: McpServer[]
  agentFiles: McpAgentFiles
  /** By agent id; an agent with no problem is absent. */
  agentProblems?: Record<string, McpAgentProblem>
}

/** One server in a host's list, as a client shows it. */
export type McpServer = {
  /** Stable across renames. */
  id: string
  name: string
  /** The URL, or the command line that starts it. */
  detail: string
  transport: 'http' | 'command'
  /** An HTTP server whose agents' own CLIs sign in to it: no saved headers and no Orca sign-in. */
  remote: boolean
  /** Present only on a server Orca signs in to itself. */
  signIn?: BotToolSignInStatus
  /** Agents it's off for; on for every other agent. */
  agentsOff: string[]
  workspaces: McpServerWorkspaces
  /** A command server Orca runs once for every agent instead of once per session. */
  sharedProcess: boolean
  /** Present on a server a plugin adds: its settings are the plugin's, and it goes with the plugin. */
  plugin?: { key: string; name: string }
}

/**
 * What `orca mcp connect` bridges an agent's stdio to: nothing (off for that agent, workspace or
 * caller), an HTTP address with the headers to send (Orca's relay and its token when Orca holds the
 * sign-in), or the command that starts it. It carries a token and secret env, so it's never logged.
 */
export type McpServerConnection =
  | { on: false }
  | { on: true; url: string; headers: Record<string, string> }
  | { on: true; command: string; args: string[]; env: Record<string, string> }

/** A server set up in an agent's own config or a repo's files, merged across agents by URL or command. */
export type DiscoveredMcpServer = {
  /** Opaque; names this entry to mcpServers.move and mcpServers.copy. */
  key: string
  name: string
  detail: string
  transport: 'http' | 'command'
  agents: string[]
  /** The absolute config paths it came from. */
  files: string[]
  /** Empty for a user-level server; for a local-scope one, the repos or folders it's limited to. */
  projectNames: string[]
  /** False for a repo's own files (shared with the team): listed, never moved. */
  movable: boolean
}

export type McpServerTypedFailureCode =
  /** The host's MCP servers switch is off. */
  | 'mcp_servers_off'
  /** No server with that id on this host. */
  | 'mcp_server_gone'
  | 'mcp_server_name_taken'
  /** Orca doesn't sign in to this server (no saved sign-in to start or end). */
  | 'mcp_server_no_sign_in'
  /** The server changed since the editor read it. */
  | 'mcp_server_stale'
  /** A shared process is only for a server Orca starts with a command. */
  | 'mcp_server_not_command'
  /** A plugin's server: only its switches change here; the plugin owns the rest. */
  | 'mcp_server_from_plugin'
  /** The calling session may not use the host's servers (Look around, a bot that hasn't opted in). */
  | 'mcp_server_not_for_caller'
  /** Declared by the contract; a later host fills it in. */
  | 'mcp_servers_not_yet'

/**
 * The key a session's workspace has in a server's Workspaces: the repo of its worktree, or the
 * folder workspace itself; null for a chat in no workspace (the floating one).
 */
export function mcpServerWorkspaceKeyOf(workspaceId: string): string | null {
  const id = normalizeWorkspaceSessionKeyToWorkspaceId(workspaceId)
  if (isFloatingWorkspaceId(id)) {
    return null
  }
  return id.startsWith('folder:') ? id : getRepoIdFromWorktreeId(id)
}

/** Whether a server is on in the workspace with this key; one named nowhere follows `later`. */
export function isMcpServerOnInWorkspace(
  workspaces: McpServerWorkspaces,
  key: string | null
): boolean {
  if (key !== null && workspaces.on.includes(key)) {
    return true
  }
  if (key !== null && workspaces.off.includes(key)) {
    return false
  }
  return workspaces.later
}
