// Mirror of cloud/packages/connector-contract/src/access-request-messages.ts for the desktop's reads.
import * as z from 'zod'
import { lazyZodSchema } from './schema/lazy-zod-schema'
import { optionalConnectorAvatarUrl } from './connector-message-asker'

/** The token from orca://bot/access-request?t=<token>, the owner's "Review in Orca": single use. */
export const ACCESS_REQUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Someone asking the owner for access to a bot, as their connector vouched for them. */
export const ConnectorAccessRequest = lazyZodSchema(() =>
  z.object({
    requestId: z.string().min(1).max(128),
    botId: z.string().min(1).max(128),
    source: z.enum(['slack', 'linear']),
    workspaceId: z.string().min(1),
    workspaceName: z.string(),
    requester: z.object({
      id: z.string().min(1),
      name: z.string(),
      /** The connector's handle: Slack's username, or Linear's display name, which anyone can edit. */
      handle: z.string(),
      /** A real name (Slack) or the email Linear verified, which identifies a Linear person. */
      detail: z.string(),
      /** Slack's picture of them; left out for Linear, or by a cloud that predates it. */
      avatarUrl: optionalConnectorAvatarUrl
    }),
    createdAt: z.number(),
    expiresAt: z.number()
  })
)
export type ConnectorAccessRequest = z.infer<typeof ConnectorAccessRequest>

// The cloud lists the newest 100; well past that is not a list it sent.
const MAX_LISTED_REQUESTS = 200

export const ConnectorAccessRequestList = lazyZodSchema(() =>
  z.object({
    requests: z.array(ConnectorAccessRequest).max(MAX_LISTED_REQUESTS),
    /** Recent grants whose bot has not listed the person yet; absent from an older cloud. */
    granted: z.array(ConnectorAccessRequest).max(MAX_LISTED_REQUESTS).optional()
  })
)
export type ConnectorAccessRequestList = z.infer<typeof ConnectorAccessRequestList>

export type BotAccessDecision = 'granted' | 'declined'

/** What a client's redeem of an owner's "Review in Orca" link came to, on one host. */
export type BotAccessRedeemOutcome =
  | { kind: 'redeemed'; botId: string; request: ConnectorAccessRequest }
  /** The link's bot is not on this host, so the token was left unspent for the host that has it. */
  | { kind: 'not-here' }
  | { kind: 'not-owner' }
  | { kind: 'expired' }
  | { kind: 'unsupported' }
  | { kind: 'failed' }
