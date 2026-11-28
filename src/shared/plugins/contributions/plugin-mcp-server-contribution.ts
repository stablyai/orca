import { z } from 'zod'
import {
  BOT_TOOL_ENV_NAME_PATTERN,
  BOT_TOOL_NAME_PATTERN,
  BotToolUrl,
  botToolDetail,
  type BotToolServer
} from '../../bot-tools'
import { pluginFieldDoc } from '../manifest/plugin-schema-field-docs'

/** First release that reads `contributes.mcpServers`. */
export const PLUGIN_MCP_SERVERS_SINCE = '1.4.276'
const SINCE = PLUGIN_MCP_SERVERS_SINCE

export const PLUGIN_MCP_SERVER_LIMIT = 16

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes('\0') && !/[\r\n]/.test(value), 'must be one line')

// Why no headers: a manifest is public, so anything secret belongs to the user's own sign-in.
export const pluginMcpServerContributionSchema = z
  .object({
    name: z
      .string()
      .regex(BOT_TOOL_NAME_PATTERN)
      .meta(
        pluginFieldDoc(
          'Server name agents see, unique in this plugin: letters, digits, `-` and `_`, at most 64.',
          SINCE,
          ['datadog']
        )
      ),
    url: BotToolUrl.optional().meta(
      pluginFieldDoc(
        'Streamable HTTP address of a remote server. Give either `url` or `command`.',
        SINCE,
        ['https://mcp.datadoghq.com/mcp']
      )
    ),
    command: text(1024)
      .refine((value) => value !== '' && value.trim() === value, 'enter one executable')
      .optional()
      .meta(pluginFieldDoc('Executable that starts a local (stdio) server.', SINCE, ['npx'])),
    args: z
      .array(text(4096))
      .max(64)
      .optional()
      .meta(pluginFieldDoc('Arguments for `command`.', SINCE, [['-y', '@acme/mcp-server']])),
    env: z
      .record(z.string().regex(BOT_TOOL_ENV_NAME_PATTERN), text(4096))
      .optional()
      .meta(pluginFieldDoc('Environment variables for `command`; nothing secret.', SINCE))
  })
  .strict()
  .superRefine((server, ctx) => {
    if ((server.url === undefined) === (server.command === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'give either url or command' })
    } else if (server.url !== undefined && (server.args || server.env)) {
      ctx.addIssue({ code: 'custom', message: 'args and env are only for a command' })
    }
  })
  .meta({
    id: 'McpServerContribution',
    description: 'An MCP server Orca offers to the agents it launches, beside the user’s own.'
  })

export type PluginMcpServerContribution = z.infer<typeof pluginMcpServerContributionSchema>

/** The server as Orca's tools file holds it; the contribution's rules are the file's, or stricter. */
export function pluginMcpServerTool(contribution: PluginMcpServerContribution): BotToolServer {
  const { name, url, command, args, env } = contribution
  if (url !== undefined) {
    return { name, url }
  }
  return { name, command: command ?? '', args: args ?? [], ...(env ? { env } : {}) }
}

/** Its name with its URL or the command line that starts it, as reviews and lists show it. */
export const pluginMcpServerListing = (
  contribution: PluginMcpServerContribution
): { name: string; detail: string } => ({
  name: contribution.name,
  detail: botToolDetail(pluginMcpServerTool(contribution))
})
