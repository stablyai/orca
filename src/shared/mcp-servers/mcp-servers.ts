// The MCP servers a host gives its agents' sessions: one list per host, kept beside bot tools in the
// same file format, with which agents and workspaces each server is on for.
import * as z from 'zod'
import type { BotToolSignInStatus } from '../bot-tool-sign-in'

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
}

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
  /** The server changed since the editor read it. */
  | 'mcp_server_stale'
  /** A shared process is only for a server Orca starts with a command. */
  | 'mcp_server_not_command'
  /** Declared by the contract; a later host fills it in. */
  | 'mcp_servers_not_yet'
