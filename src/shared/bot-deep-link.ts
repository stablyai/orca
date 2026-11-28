import { ACCESS_REQUEST_TOKEN_PATTERN } from './connector-bot-access-contract'
import type { ConnectorConnectSource } from './connectors/connector-cloud-contract'
import { CONNECTOR_SOURCES, type ConnectorSource } from './connectors/external-conversation-link'

/** `orca://bot/<botId>?conversation=<source>:<externalId>`, the "Open in Orca" link on bot thread posts; bare `orca://bot/<botId>` opens the bot's Home. */
export type BotDeepLink = {
  botId: string
  conversation?: { source: ConnectorSource; externalId: string }
  sessionId?: string
  itemId?: string
  /** `?workspace=<worktreeId>[&agent=<sessionId>]`, from `orca bot link`: a workspace on the bot's
   *  computer, opened in the window it is clicked in. Never with `conversation`. Clients that
   *  don't read it open the bot's Home. */
  workspace?: BotDeepLinkWorkspace
}

export type BotDeepLinkWorkspace = { worktreeId: string; agentSessionId?: string }

export type ConnectorLinkSource = ConnectorConnectSource

/**
 * `orca://<source>/link?t=<result>` from a connect trip's "Open Orca", when this computer had no
 * loopback port: the trip's one-time result, redeemed as is.
 */
export type ConnectorLinkDeepLink = { source: ConnectorLinkSource; token: string }

/** `orca://bot/access-request?t=<token>`, the owner's "Review in Orca" on a request for access to a bot. */
export type BotAccessRequestDeepLink = { token: string }

/** A pulled bot link: main focused its terminal, the renderer opens its chat, or it is gone. */
export type BotDeepLinkOutcome =
  | { kind: 'chat'; workspaceId: string; sessionId: string; itemId?: string }
  // `conversation`: this computer has no chat for the link's thread, so it may be another computer's bot.
  | {
      kind: 'home'
      botId: string
      conversation?: BotDeepLink['conversation']
      workspace?: BotDeepLinkWorkspace
    }
  | { kind: 'missing' }
  | ({ kind: 'connector-link' } & ConnectorLinkDeepLink)
  | ({ kind: 'access-request' } & BotAccessRequestDeepLink)
  | { kind: 'bot-share'; shareId: string }

const ACCESS_REQUEST_PATH = 'access-request'

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
// Matched exactly against stored links, never used as a path; bounded and printable only.
const EXTERNAL_ID_PATTERN = /^[\x21-\x7e]{1,512}$/
// A worktree id is `<repoId>::<path>`; matched against the catalog, never opened as a path.
const WORKTREE_ID_PATTERN = /^[^\x00-\x1f\x7f]{1,2048}$/

/** An agent's orca session id as a workspace link carries it (without `orca_session_id:`). */
export function isBotDeepLinkSessionId(value: string): boolean {
  return BOT_ID_PATTERN.test(value)
}

function parseWorkspace(url: URL): BotDeepLinkWorkspace | null | undefined {
  const worktreeId = url.searchParams.get('workspace')
  const agent = url.searchParams.get('agent')
  if (worktreeId === null) {
    return agent === null ? undefined : null
  }
  if (!WORKTREE_ID_PATTERN.test(worktreeId) || (agent !== null && !BOT_ID_PATTERN.test(agent))) {
    return null
  }
  return { worktreeId, ...(agent ? { agentSessionId: agent } : {}) }
}

function isConnectorSource(value: string): value is ConnectorSource {
  return CONNECTOR_SOURCES.some((source) => source === value)
}

export function parseBotDeepLink(value: string): BotDeepLink | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'orca:' || url.host !== 'bot') {
    return null
  }
  const botId = url.pathname.match(/^\/([^/]+)\/?$/)?.[1]
  if (!botId || !BOT_ID_PATTERN.test(botId) || botId === ACCESS_REQUEST_PATH) {
    return null
  }
  const conversation = url.searchParams.get('conversation')
  if (conversation === null) {
    const workspace = parseWorkspace(url)
    if (workspace === null) {
      return null
    }
    return workspace ? { botId, workspace } : { botId }
  }
  const separator = conversation.indexOf(':')
  const source = conversation.slice(0, separator)
  const externalId = conversation.slice(separator + 1)
  if (separator === -1 || !isConnectorSource(source) || !EXTERNAL_ID_PATTERN.test(externalId)) {
    return null
  }
  const sessionId = url.searchParams.get('session')
  const itemId = url.searchParams.get('item')
  if (
    (sessionId !== null && !BOT_ID_PATTERN.test(sessionId)) ||
    (itemId !== null && (!sessionId || !EXTERNAL_ID_PATTERN.test(itemId) || itemId.length > 128))
  ) {
    return null
  }
  return {
    botId,
    conversation: { source, externalId },
    ...(sessionId ? { sessionId } : {}),
    ...(itemId ? { itemId } : {})
  }
}

export function formatBotDeepLink({
  botId,
  conversation,
  sessionId,
  itemId,
  workspace
}: BotDeepLink): string {
  const url = new URL(`orca://bot/${botId}`)
  if (!conversation && workspace) {
    url.searchParams.set('workspace', workspace.worktreeId)
    if (workspace.agentSessionId) {
      url.searchParams.set('agent', workspace.agentSessionId)
    }
  }
  if (conversation) {
    url.searchParams.set('conversation', `${conversation.source}:${conversation.externalId}`)
    if (sessionId) {
      url.searchParams.set('session', sessionId)
      if (itemId) {
        url.searchParams.set('item', itemId)
      }
    }
  }
  return url.toString()
}

export function parseBotAccessRequestDeepLink(value: string): BotAccessRequestDeepLink | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (
    url.protocol !== 'orca:' ||
    url.host !== 'bot' ||
    url.pathname !== `/${ACCESS_REQUEST_PATH}`
  ) {
    return null
  }
  const token = url.searchParams.get('t')
  return token !== null && ACCESS_REQUEST_TOKEN_PATTERN.test(token) ? { token } : null
}

export function formatBotAccessRequestDeepLink({ token }: BotAccessRequestDeepLink): string {
  return `orca://bot/${ACCESS_REQUEST_PATH}?t=${encodeURIComponent(token)}`
}
