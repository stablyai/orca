// Composio apps a bot uses as tools. The owner brings their own Composio project key; Orca keeps it
// on the bot's host and reads Composio's app list and each bot's sign-ins with it.

/** How an app signs in: through Composio's own app, through one the owner adds in Composio, or not at all. */
/**
 * How an app signs in through Composio:
 * - `composio`: Composio's own sign-in (OAuth), or one the owner added under Auth Configs.
 * - `key`: Composio's page asks for the app's own API key or password.
 * - `own`: only through a developer app the owner adds under Auth Configs first.
 * - `none`: nothing to sign in to.
 */
export type ComposioAppSignIn = 'composio' | 'key' | 'own' | 'none'

export type ComposioApp = {
  slug: string
  name: string
  /** One short line, not Composio's long text. */
  description: string
  logo: string | null
  signIn: ComposioAppSignIn
}

export type ComposioConnectionStatus = 'active' | 'pending' | 'expired' | 'failed'

/** One of a bot's app sign-ins at Composio. */
export type ComposioConnection = {
  id: string
  app: string
  /** The app's name as Composio gives it; the slug when it couldn't be read. */
  name: string
  status: ComposioConnectionStatus
  /** Who it signed in as, when Composio says. */
  label: string | null
}

/**
 * - `none`: no key saved on this host.
 * - `ok`: saved; Composio last accepted it, or hasn't been asked since this host started.
 * - `rejected`: Composio refused it; every bot's Composio apps wait for a new one.
 * - `unreadable`: saved but this host can't decrypt it.
 */
export type ComposioKeyState = 'none' | 'ok' | 'rejected' | 'unreadable'

/** Composio is limiting the project: until `retryAt`, or for the month when null. */
export type ComposioLimit = { retryAt: number | null }

export type ComposioStatus = {
  key: ComposioKeyState
  /** Composio's rate or plan limit, when its last answer was one. */
  limit: ComposioLimit | null
  /** The bot has its Composio tool, so it can use the apps it connects. */
  added: boolean
}

/** The owner's key on this computer, named by its last characters; the key itself is never sent. */
/**
 * Where the key's project sends its events, as this computer's last upkeep saw it: `here` to this
 * computer's events hook, `elsewhere` to another address while its automations here wait on them.
 */
export type ComposioEventsPlace = { project: string; here: boolean; elsewhere: boolean }

export type ComposioKey = {
  key: ComposioKeyState
  hint: string | null
  /** Absent from an older Orca, or before upkeep ran with this key. */
  events?: ComposioEventsPlace | null
}

export type ComposioAppPage = { apps: ComposioApp[]; nextCursor: string | null }

/** An app sign-in Orca is waiting on, which a Connect started. */
export type ComposioPendingConnect = { app: string; url: string; startedAt: number }

export type ComposioConnections = {
  connections: ComposioConnection[]
  pending: ComposioPendingConnect[]
}

// `~/project` opens the signed-in owner's current project, as Composio's own docs link it.
const COMPOSIO_PROJECT = 'https://dashboard.composio.dev/~/project'
/** The Composio pages Orca sends the owner to; never the dashboard's home. */
export const COMPOSIO_PAGES = {
  apiKeys: `${COMPOSIO_PROJECT}/settings/api-keys`,
  // Webhooks is a tab here; it has no documented link of its own.
  settings: `${COMPOSIO_PROJECT}/settings`,
  authConfigs: `${COMPOSIO_PROJECT}/auth-configs`,
  users: `${COMPOSIO_PROJECT}/users`,
  usage: `${COMPOSIO_PROJECT}/settings/usage`
} as const
/** Composio's page for one app, with how to make the developer app it signs in through. */
export const composioAppGuideUrl = (slug: string): string =>
  `https://docs.composio.dev/toolkits/${encodeURIComponent(slug)}`
export const COMPOSIO_TOOL_NAME = 'composio'
/** The source Orca's tool relay fills with the owner's current Composio key on each call. */
export const COMPOSIO_HEADER_SOURCE = 'composio'
/** The session MCP address Composio gives, which names the session. */
export const COMPOSIO_SESSION_MCP_URL =
  /^https:\/\/backend\.composio\.dev\/tool_router\/([\w-]+)\/mcp$/

/** The logo Composio serves for any app without a key; an unknown slug gets a stand-in image. */
export const composioLogoUrl = (slug: string): string =>
  `https://logos.composio.dev/api/${encodeURIComponent(slug)}`

/** The Composio user a bot's sign-ins belong to, so each bot connects its own apps. */
export const composioUserOfBot = (botId: string): string => `orca-bot-${botId}`
