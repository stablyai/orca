import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { BOT_TOOL_NAME_PATTERN, BotToolInputSchema } from '../bot-tools'
import { OptionalString } from './rpc-param-primitives'

// Absent botId: the bot whose chat ran the command.
const Target = { botId: OptionalString, callerSessionId: OptionalString }
const ToolName = lazyZodSchema(() =>
  z.string().regex(BOT_TOOL_NAME_PATTERN, 'A tool name is letters, digits, - and _')
)

export const BotToolsList = lazyZodSchema(() => z.object(Target))
// remote: only the URL servers, so the check starts no command.
export const BotToolProblems = lazyZodSchema(() =>
  z.object({ ...Target, scope: z.enum(['all', 'remote']).optional() })
)

const BotToolPasteAdd = lazyZodSchema(() =>
  z.strictObject({
    ...Target,
    // An MCP server's URL, or the command line that starts it.
    source: z.string().trim().min(1, 'Paste a URL or the command that starts the server').max(4096),
    name: ToolName.optional()
  })
)

export const BotToolAdd = lazyZodSchema(() =>
  z.union([BotToolPasteAdd, z.strictObject({ ...Target, config: BotToolInputSchema })])
)
export const BotToolUpdate = lazyZodSchema(() =>
  z.strictObject({
    ...Target,
    name: ToolName,
    version: z.string().regex(/^[a-f0-9]{64}$/),
    config: BotToolInputSchema
  })
)

export const BotToolTarget = lazyZodSchema(() => z.object({ ...Target, name: ToolName }))

// Whether the bot's sessions also take its host's MCP server list.
export const BotToolsSetHostMcpServers = lazyZodSchema(() =>
  z.strictObject({ ...Target, enabled: z.boolean() })
)

// The address a sign-in's browser ended on, for a host the browser couldn't reach.
export const BotToolFinishSignIn = lazyZodSchema(() =>
  z.object({
    ...Target,
    name: ToolName,
    address: z.string().trim().min(1, 'Paste the address the sign-in page ended on').max(8192)
  })
)

// Orca's own sign-in run on the bot's host for the calling device. `routed`: the device opens the
// page in Orca's browser routed to the host, whose own listener takes the return; `paste`: the device
// sends back the query of the address its browser ended on.
export const BotToolSignInStart = lazyZodSchema(() =>
  z.object({
    ...Target,
    name: ToolName,
    mode: z.enum(['routed', 'paste'])
  })
)
const SignInFlow = { callerSessionId: OptionalString, flowId: z.string().min(1).max(64) }
export const BotToolSignInFlow = lazyZodSchema(() => z.object(SignInFlow))
export const BotToolSignInWait = lazyZodSchema(() =>
  z.object({
    ...SignInFlow,
    afterRevision: z.number().int().nonnegative().default(0)
  })
)
// Only the query the browser returned with; the host never fetches a client's address.
export const BotToolSignInFinish = lazyZodSchema(() =>
  z.object({
    ...SignInFlow,
    query: z.string().trim().min(1).max(8_192)
  })
)

export type BotToolsTargetParams = z.infer<typeof BotToolsList>
export type BotToolAddParams = z.infer<typeof BotToolAdd>
export type BotToolTargetParams = z.infer<typeof BotToolTarget>
