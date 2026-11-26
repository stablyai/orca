// The vendors' own MCP servers that Add to <bot> lists. Each one passes the weekly app check
// (config/scripts/bot-apps); its README says how to add one.

export type BotAppCategory = 'coding' | 'chat' | 'monitoring' | 'docs' | 'mail' | 'sales' | 'design'

/** Add to <bot>'s category order; a category shows only while it lists an app. */
export const BOT_APP_CATEGORIES: readonly BotAppCategory[] = [
  'coding',
  'chat',
  'monitoring',
  'docs',
  'mail',
  'sales',
  'design'
]

export type BotMcpApp = {
  /** The tool's name on the bot. */
  id: string
  name: string
  /** What the app does for the bot, before it is added. */
  line: string
  /** With `variable`, a template whose `{key}` blank is filled on add. */
  url: string
  variable?: BotMcpAppUrlVariable
  /** browser: the server answers 401 and the bot's CLI signs in in a browser. none: no sign-in. */
  signIn: 'browser' | 'none'
  category: BotAppCategory
  /** The same app's slugs in Composio's catalog, so the Add dialog lists it once. */
  composio?: readonly string[]
}

/**
 * A blank in an app's URL, filled on add (the MCP registry's server.json URL variable). With
 * `choices`, a site picked from a list; without, an optional host typed behind Advanced.
 */
export type BotMcpAppUrlVariable = {
  /** The `{key}` blank in the app's `url`. */
  key: string
  label: string
  /** What fills the blank until the user gives another value. */
  default: string
} & ({ choices: readonly BotMcpAppSite[] } | { placeholder: string; hint: string })

/** `name` is the vendor's own name for the site; `value` fills the blank. */
export type BotMcpAppSite = { name: string; place: string; value: string }

/** The app's server URL with its blank filled by `value`, or by the default when none is given. */
export function botMcpAppUrl(app: Pick<BotMcpApp, 'url' | 'variable'>, value?: string): string {
  const variable = app.variable
  return variable ? app.url.replace(`{${variable.key}}`, value || variable.default) : app.url
}

function parseWebUrl(text: string): URL | null {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null
  } catch {
    return null
  }
}

/**
 * Which value a URL the app was added at fills its blank with: the site's name or the host, and
 * whether it is the default. Null for a URL the app's template doesn't make, whole path included.
 */
export function botMcpAppUrlPlace(
  app: Pick<BotMcpApp, 'url' | 'variable'>,
  url: string
): { name: string; isDefault: boolean } | null {
  const variable = app.variable
  const parsed = parseWebUrl(url)
  if (!variable || !parsed) {
    return null
  }
  const makes = (value?: string): boolean =>
    parseWebUrl(botMcpAppUrl(app, value))?.href === parsed.href
  const named =
    'choices' in variable
      ? variable.choices.find((choice) => makes(choice.value))?.name
      : makes(parsed.host)
        ? parsed.host
        : undefined
  return named === undefined ? null : { name: named, isDefault: makes() }
}

/** The tag a row shows for an app added at another site or host; null at the default. */
export function botMcpAppUrlTag(
  app: Pick<BotMcpApp, 'url' | 'variable'>,
  url: string
): string | null {
  const place = botMcpAppUrlPlace(app, url)
  return place && !place.isDefault ? place.name : null
}

/**
 * A typed GitLab-style address as a URL's host and optional port: a bare authority, or a pasted
 * http(s) URL whose path is dropped and whose typed port stays. '' when empty; null for userinfo,
 * another scheme, port 0, or anything the URL parser refuses (bad IDNA included).
 */
export function botMcpAppHost(input: string): string | null {
  const text = input.trim()
  if (!text) {
    return ''
  }
  // A scheme, unless it is a bare host:port; http(s) is read under https so a typed port stays.
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:/?#]+:\d+(?:[/?#]|$)/.test(text)
  if (scheme && !/^https?:/i.test(text)) {
    return null
  }
  const url = parseWebUrl(scheme ? text.replace(/^https?:/i, 'https:') : `https://${text}`)
  if (!url || !url.hostname || url.username || url.password || url.port === '0') {
    return null
  }
  return url.port ? `${url.hostname}:${url.port}` : url.hostname
}

export const BOT_MCP_APPS: readonly BotMcpApp[] = [
  {
    id: 'vercel',
    name: 'Vercel',
    line: 'Check deployments and read their logs',
    url: 'https://mcp.vercel.com',
    signIn: 'browser',
    category: 'coding'
  },
  {
    id: 'sentry',
    name: 'Sentry',
    line: 'Look into errors and the events behind them',
    url: 'https://mcp.sentry.dev/mcp',
    signIn: 'browser',
    category: 'monitoring',
    composio: ['sentry']
  },
  {
    id: 'datadog',
    name: 'Datadog',
    line: 'Search logs, metrics and monitors',
    url: 'https://mcp.{site}/v1/mcp',
    // The US1-FED and US2-FED sites have no MCP server.
    variable: {
      key: 'site',
      label: 'Datadog site',
      default: 'datadoghq.com',
      choices: [
        { name: 'US1', place: 'US East', value: 'datadoghq.com' },
        { name: 'US3', place: 'US West', value: 'us3.datadoghq.com' },
        { name: 'US5', place: 'US Central', value: 'us5.datadoghq.com' },
        { name: 'EU', place: 'Europe', value: 'datadoghq.eu' },
        { name: 'AP1', place: 'Japan', value: 'ap1.datadoghq.com' },
        { name: 'AP2', place: 'Australia', value: 'ap2.datadoghq.com' },
        { name: 'UK1', place: 'United Kingdom', value: 'uk1.datadoghq.com' }
      ]
    },
    signIn: 'browser',
    category: 'monitoring'
  },
  {
    id: 'posthog',
    name: 'PostHog',
    line: 'Query product analytics and feature flags',
    url: 'https://mcp.posthog.com/mcp',
    signIn: 'browser',
    category: 'monitoring'
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    line: 'Manage Workers, DNS and the rest of an account',
    url: 'https://mcp.cloudflare.com/mcp',
    signIn: 'browser',
    category: 'coding'
  },
  {
    id: 'supabase',
    name: 'Supabase',
    line: 'Query databases and manage projects',
    url: 'https://mcp.supabase.com/mcp',
    signIn: 'browser',
    category: 'coding'
  },
  {
    id: 'neon',
    name: 'Neon',
    line: 'Run SQL and manage Postgres branches',
    url: 'https://mcp.neon.tech/mcp',
    signIn: 'browser',
    category: 'coding'
  },
  {
    id: 'netlify',
    name: 'Netlify',
    line: 'Deploy sites and check their builds',
    url: 'https://mcp.netlify.com/mcp',
    signIn: 'browser',
    category: 'coding'
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    line: 'Read and update issues and merge requests',
    url: 'https://{host}/api/v4/mcp',
    // Self-managed and Dedicated instances serve it at their own host.
    variable: {
      key: 'host',
      label: 'GitLab address (optional)',
      default: 'gitlab.com',
      placeholder: 'gitlab.example.com',
      hint: 'For self-managed or Dedicated. Leave empty for GitLab.com.'
    },
    signIn: 'browser',
    category: 'coding'
  },
  {
    id: 'context7',
    name: 'Context7',
    line: 'Current docs and examples for code libraries',
    url: 'https://mcp.context7.com/mcp',
    signIn: 'none',
    category: 'coding'
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    line: 'Jira issues and Confluence pages',
    url: 'https://mcp.atlassian.com/v2/mcp',
    signIn: 'browser',
    category: 'docs',
    composio: ['jira', 'confluence']
  },
  {
    id: 'notion',
    name: 'Notion',
    line: 'Search, read and edit pages',
    url: 'https://mcp.notion.com/mcp',
    signIn: 'browser',
    category: 'docs',
    composio: ['notion']
  },
  {
    id: 'stripe',
    name: 'Stripe',
    line: 'Look up payments, customers and subscriptions',
    url: 'https://mcp.stripe.com',
    signIn: 'browser',
    category: 'sales',
    composio: ['stripe']
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    line: 'Manage tasks, lists and docs',
    url: 'https://mcp.clickup.com/mcp',
    signIn: 'browser',
    category: 'docs',
    composio: ['clickup']
  },
  {
    id: 'airtable',
    name: 'Airtable',
    line: 'Query and edit bases, tables and records',
    url: 'https://mcp.airtable.com/mcp',
    signIn: 'browser',
    category: 'docs',
    composio: ['airtable']
  },
  {
    id: 'todoist',
    name: 'Todoist',
    line: 'Add, sort and complete tasks',
    url: 'https://ai.todoist.net/mcp',
    signIn: 'browser',
    category: 'docs',
    composio: ['todoist']
  },
  {
    id: 'zapier',
    name: 'Zapier',
    line: 'Run actions in the apps you set up in Zapier',
    url: 'https://mcp.zapier.com/api/v1/connect',
    signIn: 'browser',
    category: 'docs'
  },
  {
    id: 'granola',
    name: 'Granola',
    line: 'Search meeting notes and transcripts',
    url: 'https://mcp.granola.ai/mcp',
    signIn: 'browser',
    category: 'mail'
  },
  {
    id: 'intercom',
    name: 'Intercom',
    line: 'Search conversations, contacts and articles',
    url: 'https://mcp.{site}/mcp',
    // Australia-hosted workspaces have no MCP server yet.
    variable: {
      key: 'site',
      label: 'Intercom region',
      default: 'intercom.com',
      choices: [
        { name: 'US', place: 'United States', value: 'intercom.com' },
        { name: 'EU', place: 'Europe', value: 'eu.intercom.com' }
      ]
    },
    signIn: 'browser',
    category: 'sales',
    composio: ['intercom']
  }
]
