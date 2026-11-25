import * as z from 'zod'
import { BOT_TOOL_NAME_PATTERN, BotToolInputSchema } from '../bot-tools'
import { MCP_SERVER_AGENT_PATTERN, McpServerWorkspacesSchema } from '../mcp-servers/mcp-servers'

const ServerId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Name a server by its id')
const Agent = z.string().regex(MCP_SERVER_AGENT_PATTERN, 'Name an agent by its id')
const ServerName = z
  .string()
  .regex(BOT_TOOL_NAME_PATTERN, 'A server name is letters, digits, - and _')

export const McpServersList = z.object({})

export const McpServerAdd = z.union([
  z.strictObject({
    // An MCP server's URL, or the command line that starts it.
    source: z.string().trim().min(1, 'Paste a URL or the command that starts the server').max(4096),
    name: ServerName.optional()
  }),
  z.strictObject({ config: BotToolInputSchema })
])

export const McpServerUpdate = z.strictObject({
  id: ServerId,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  config: BotToolInputSchema
})

export const McpServerTarget = z.object({ id: ServerId })

// `agent`: which agent's CLI checks them (default Claude Code); `remote`: only URL servers, so no command starts.
export const McpServerProblems = z.object({
  agent: z.enum(['claude', 'codex']).optional(),
  scope: z.enum(['all', 'remote']).optional()
})

// Orca's own sign-in, run on the host for the calling device. `routed`: the host's listener takes the
// browser's return (the desktop on this computer, or a page routed to it); `paste`: the device sends
// back the query of the address its browser ended on.
export const McpServerSignInStart = z.object({ id: ServerId, mode: z.enum(['routed', 'paste']) })
const SignInFlow = { flowId: z.string().min(1).max(64) }
export const McpServerSignInFlow = z.object(SignInFlow)
export const McpServerSignInWait = z.object({
  ...SignInFlow,
  afterRevision: z.number().int().nonnegative().default(0)
})
// Only the query the browser returned with; the host never fetches a client's address.
export const McpServerSignInFinish = z.object({
  ...SignInFlow,
  query: z.string().trim().min(1).max(8_192)
})

export const McpServerDiscover = z.object({})

// `key`: a discovered server's, from mcpServers.discover.
export const McpServerImport = z.object({ key: z.string().min(1).max(512) })

// The agents whose own MCP file Orca keeps its servers in, with the user's consent.
export const McpServerAgentFilesAllow = z.object({
  agent: z.enum(['grok', 'cursor', 'droid']),
  allowed: z.boolean()
})

export const McpServerSetAgentEnabled = z.object({
  id: ServerId,
  agent: Agent,
  enabled: z.boolean()
})

export const McpServerSetWorkspaces = z.object({
  id: ServerId,
  workspaces: McpServerWorkspacesSchema
})

export const McpServerSetSharedProcess = z.object({ id: ServerId, enabled: z.boolean() })

export type McpServerAddParams = z.infer<typeof McpServerAdd>
