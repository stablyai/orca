// The vendors' own MCP servers that Add to <bot> lists. Each one passes the weekly app check
// (config/scripts/bot-apps); its README says how to add one.

export type BotAppCategory = 'coding' | 'chat' | 'monitoring' | 'docs' | 'mail' | 'sales' | 'design'

export type BotMcpApp = {
  /** The tool's name on the bot. */
  id: string
  name: string
  /** What the app does for the bot, before it is added. */
  line: string
  url: string
  /** browser: the server answers 401 and the bot's CLI signs in in a browser. none: no sign-in. */
  signIn: 'browser' | 'none'
  category: BotAppCategory
  /** The same app's slugs in Composio's catalog, so the Add dialog lists it once. */
  composio?: readonly string[]
  /** Regions the vendor runs separately; the first is `url` and the default. */
  sites?: readonly BotMcpAppSite[]
}

export type BotMcpAppSite = { id: string; name: string; url: string }

export const DATADOG_SITES: readonly BotMcpAppSite[] = [
  { id: 'us1', name: 'US1', url: 'https://mcp.datadoghq.com/v1/mcp' },
  { id: 'us3', name: 'US3', url: 'https://mcp.us3.datadoghq.com/v1/mcp' },
  { id: 'us5', name: 'US5', url: 'https://mcp.us5.datadoghq.com/v1/mcp' },
  { id: 'eu1', name: 'EU1', url: 'https://mcp.datadoghq.eu/v1/mcp' },
  { id: 'ap1', name: 'AP1', url: 'https://mcp.ap1.datadoghq.com/v1/mcp' },
  { id: 'ap2', name: 'AP2', url: 'https://mcp.ap2.datadoghq.com/v1/mcp' }
]

/** The app's URL for a site; the default URL when the app has no such site. */
export function botMcpAppSiteUrl(app: Pick<BotMcpApp, 'url' | 'sites'>, siteId: string): string {
  return app.sites?.find((site) => site.id === siteId)?.url ?? app.url
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
    url: DATADOG_SITES[0].url,
    signIn: 'browser',
    category: 'monitoring',
    sites: DATADOG_SITES
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
    url: 'https://gitlab.com/api/v4/mcp',
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
  }
]
