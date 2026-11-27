import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { BOT_TOOL_NAME_PATTERN, BotToolInputSchema } from '../bot-tools'
import {
  MCP_FILE_AGENTS,
  MCP_SERVER_AGENT_PATTERN,
  McpServerWorkspacesSchema
} from '../mcp-servers/mcp-servers'

const ServerId = lazyZodSchema(() =>
  z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Name a server by its id')
)
const Agent = lazyZodSchema(() =>
  z.string().regex(MCP_SERVER_AGENT_PATTERN, 'Name an agent by its id')
)
const ServerName = lazyZodSchema(() =>
  z.string().regex(BOT_TOOL_NAME_PATTERN, 'A server name is letters, digits, - and _')
)

export const McpServersList = lazyZodSchema(() => z.object({}))

// A server's URL or start command, an mcpServers block, or `claude/codex mcp add` lines.
const PasteSource = lazyZodSchema(() =>
  z.string().trim().min(1, 'Paste a URL or the command that starts the server').max(4096)
)

// `workspaces`: where it's on from the start, in the same write (a repo's "Add a server for this
// repo"); all workspaces without it.
const addedWorkspaces = () => ({ workspaces: McpServerWorkspacesSchema.optional() })

export const McpServerAdd = lazyZodSchema(() =>
  z.union([
    // `name` renames a paste that names one server; a paste naming several adds each.
    z.strictObject({ source: PasteSource, name: ServerName.optional(), ...addedWorkspaces() }),
    z.strictObject({ config: BotToolInputSchema, ...addedWorkspaces() })
  ])
)

export const McpServerUpdate = lazyZodSchema(() =>
  z.strictObject({
    id: ServerId,
    version: z.string().regex(/^[a-f0-9]{64}$/),
    config: BotToolInputSchema
  })
)

export const McpServerTarget = lazyZodSchema(() => z.object({ id: ServerId }))

// `agent`: which agent's CLI checks them (default Claude Code); `remote`: only URL servers, so no command starts.
export const McpServerProblems = lazyZodSchema(() =>
  z.object({
    agent: z.enum(['claude', 'codex']).optional(),
    scope: z.enum(['all', 'remote']).optional()
  })
)

// Orca's own sign-in, run on the host for the calling device. `routed`: the host's listener takes the
// browser's return (the desktop on this computer, or a page routed to it); `paste`: the device sends
// back the query of the address its browser ended on.
export const McpServerSignInStart = lazyZodSchema(() =>
  z.object({ id: ServerId, mode: z.enum(['routed', 'paste']) })
)
const signInFlow = () => ({ flowId: z.string().min(1).max(64) })
export const McpServerSignInFlow = lazyZodSchema(() => z.object(signInFlow()))
export const McpServerSignInWait = lazyZodSchema(() =>
  z.object({
    ...signInFlow(),
    afterRevision: z.number().int().nonnegative().default(0)
  })
)
// Only the query the browser returned with; the host never fetches a client's address.
export const McpServerSignInFinish = lazyZodSchema(() =>
  z.object({
    ...signInFlow(),
    query: z.string().trim().min(1).max(8_192)
  })
)

export const McpServerPreviewPaste = lazyZodSchema(() => z.strictObject({ source: PasteSource }))

export const McpServerDiscover = lazyZodSchema(() => z.object({}))

// `key`: a discovered server's, from mcpServers.discover.
export const McpServerImport = lazyZodSchema(() => z.object({ key: z.string().min(1).max(512) }))
// `agents`: the ones its confirm said it leaves; the host takes it out of no other agent's files.
// Absent from older clients.
export const McpServerMove = lazyZodSchema(() =>
  McpServerImport.extend({
    agents: z.array(z.string().min(1).max(64)).max(64).optional()
  })
)

// The agents whose own MCP file Orca keeps its servers in, with the user's consent.
export const McpServerAgentFilesAllow = lazyZodSchema(() =>
  z.object({
    agent: z.enum(MCP_FILE_AGENTS),
    allowed: z.boolean()
  })
)

// `orca mcp connect` in an agent's own MCP file: the workspace its session runs in (null for none),
// its folder (whose own MCP files may name the server too), and who is calling, so a Look around or a
// bot that hasn't opted in gets nothing.
export const McpServerConnect = lazyZodSchema(() =>
  z.strictObject({
    id: ServerId,
    agent: Agent,
    workspaceId: z.string().min(1).max(4096).nullable(),
    cwd: z.string().min(1).max(4096).optional(),
    botToken: z.string().min(1).max(512).optional(),
    callerSessionId: z.string().min(1).max(512).optional()
  })
)

export const McpServerSetAgentEnabled = lazyZodSchema(() =>
  z.object({
    id: ServerId,
    agent: Agent,
    enabled: z.boolean()
  })
)

// `base` is the choice the edit was made from, so the host writes only what changed; an older host
// drops it and stores `workspaces` whole.
export const McpServerSetWorkspaces = lazyZodSchema(() =>
  z.object({
    id: ServerId,
    workspaces: McpServerWorkspacesSchema,
    base: McpServerWorkspacesSchema.optional()
  })
)

export const McpServerSetSharedProcess = lazyZodSchema(() =>
  z.object({ id: ServerId, enabled: z.boolean() })
)

// Sessions still on an older list: how many, and how many Orca can restart in place.
export const McpServerSessions = lazyZodSchema(() => z.object({}))

export type McpServerAddParams = z.infer<typeof McpServerAdd>
