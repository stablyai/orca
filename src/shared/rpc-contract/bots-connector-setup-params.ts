// `bots.slack.*`, `bots.linear.*`, `bots.github.*` and `bots.connect.*`: a host's Slack, Linear and
// GitHub setup, run as that host's own Orca account for whichever client asks.
import * as z from 'zod'
import {
  SLACK_CONFIG_REFRESH_TOKEN_MAX_LENGTH,
  SLACK_CONFIG_REFRESH_TOKEN_PREFIX
} from '../connector-bot-slack-contract'
import { CONNECTOR_CONNECT_SOURCES } from '../connectors/connector-cloud-contract'

const Id = z.string().min(1).max(256)
const Query = z.string().max(200)

export const BotSlackGrant = z.object({
  refreshToken: z
    .string()
    .trim()
    .startsWith(SLACK_CONFIG_REFRESH_TOKEN_PREFIX)
    .max(SLACK_CONFIG_REFRESH_TOKEN_MAX_LENGTH)
})
export const BotSlackTeam = z.object({ teamId: Id })
/** Without a team, the bot's first workspace (remove: every workspace). */
export const BotSlackBot = z.object({ botId: Id, teamId: Id.optional() })
export const BotSlackSetUp = z.object({ botId: Id, teamId: Id })
export const BotSlackMembers = z.object({ botId: Id, query: Query, teamId: Id.optional() })
/** What messages typed at the bot's computer post as; `setupState` is the after-install pick's. */
export const BotSlackPostAs = z.union([
  z.object({
    botId: Id,
    teamId: Id,
    postAs: z.enum(['person', 'computer']),
    setupState: Id.optional()
  }),
  z.object({ botId: Id, teamId: Id, cancel: z.literal(true) })
])

export const BotLinearWorkspace = z.object({ workspaceId: Id })
export const BotLinearMembers = z.object({ workspaceId: Id, query: Query })
export const BotLinearDefaultBot = z.object({ workspaceId: Id, botId: Id.nullable() })

/** `scope`: the connected repositories ("owner/name") and whole-account installs to search first. */
export const BotGitHubUsers = z.object({
  query: Query,
  scope: z
    .object({
      repositories: z.array(z.string().max(200)).max(200),
      organizations: z.array(z.string().max(100)).max(50)
    })
    .optional()
})
export const BotGitHubDefaultBot = z.object({ botId: Id.nullable() })

const Source = z.enum(CONNECTOR_CONNECT_SOURCES)
/** `switchAccount` is "Not you?", which lets the person pick another account. */
export const ConnectorConnectStart = z.object({ source: Source, switchAccount: z.boolean() })
export const ConnectorConnectWait = z.object({ tripId: z.uuid() })
export const ConnectorConnectCancel = z.object({ source: Source })
/** The "Open Orca" fallback's result, from orca://<source>/link; the host checks its shape. */
export const ConnectorConnectRedeemParams = z.object({
  source: Source,
  result: z.string().max(512)
})
