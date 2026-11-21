// What "Add to <bot>" lists: each app once, under the route that reaches it directly (Orca's own
// connector, later an official server), in its natural category; Composio's apps in a section of
// their own. A new MCP app is one BOT_MCP_APPS entry and its logo in BotAppBrandLogo.
import { translate } from '@/i18n/i18n'
import type { BotConnector } from '../bot-connectors'
import {
  BOT_MCP_APPS,
  type BotAppCategory,
  type BotMcpApp
} from '../../../../../shared/bots/bot-mcp-apps'
import {
  COMPOSIO_CURATED_APPS,
  type ComposioCuratedApp
} from '../../../../../shared/composio/composio-curated-apps'

export type { BotAppCategory }

/** Rail order; a category shows only while it lists an app. */
export const BOT_APP_CATEGORIES: readonly BotAppCategory[] = [
  'coding',
  'chat',
  'monitoring',
  'docs',
  'mail',
  'sales',
  'design'
]

export function botAppCategoryName(category: BotAppCategory): string {
  switch (category) {
    case 'coding':
      return translate('bots.apps.category.coding', 'Coding')
    case 'chat':
      return translate('bots.apps.category.chat', 'Chat')
    case 'monitoring':
      return translate('bots.apps.category.monitoring', 'Monitoring')
    case 'docs':
      return translate('bots.apps.category.docs', 'Docs and projects')
    case 'mail':
      return translate('bots.apps.category.mail', 'Mail and meetings')
    case 'sales':
      return translate('bots.apps.category.sales', 'Sales and support')
    case 'design':
      return translate('bots.apps.category.design', 'Design')
  }
}

/** An app the bot reaches directly. `composio` names the same app in Composio's catalog. */
export type BotDirectApp = { category: BotAppCategory; composio?: readonly string[] } & (
  | {
      /** One of Orca's own connectors, set up by its own dialogs. */
      route: 'connector'
      connector: Exclude<BotConnector['id'], 'webhooks' | 'discord'>
    }
  | {
      /** An MCP server: added to the bot's tools by URL under `id`, then signed in to in a browser. */
      route: 'mcp'
      id: string
      name: string
      line: string
      url: string
      variable?: BotMcpApp['variable']
      signIn: BotMcpApp['signIn']
    }
)

export const DIRECT_APPS: readonly BotDirectApp[] = [
  { route: 'connector', connector: 'github', category: 'coding', composio: ['github'] },
  { route: 'connector', connector: 'slack', category: 'chat', composio: ['slack'] },
  { route: 'connector', connector: 'linear', category: 'docs', composio: ['linear'] },
  { route: 'connector', connector: 'google', category: 'mail', composio: ['gmail'] },
  { route: 'connector', connector: 'dingtalk', category: 'chat' },
  ...BOT_MCP_APPS.map(
    ({ id, name, line, url, variable, signIn, category, composio }): BotDirectApp => ({
      route: 'mcp',
      id,
      name,
      line,
      url,
      variable,
      signIn,
      category,
      composio
    })
  )
]

/** A row's one line: what the app does for the bot, before it is added. */
export function directAppLine(app: BotDirectApp): string {
  if (app.route === 'mcp') {
    return app.line
  }
  switch (app.connector) {
    case 'github':
      return translate('bots.apps.line.github', 'Mentions and events on issues and PRs')
    case 'slack':
      return translate('bots.apps.line.slack', 'Messages and mentions')
    case 'linear':
      return translate('bots.apps.line.linear', 'Assigned issues and mentions')
    case 'google':
      return translate('bots.apps.line.google', 'Gmail, Calendar and Drive, as you')
    case 'dingtalk':
      return translate('bots.apps.line.dingtalk', 'Messages and mentions from DingTalk groups')
  }
}

const DIRECT_COMPOSIO = new Set(DIRECT_APPS.flatMap((app) => app.composio ?? []))

/** Whether a Composio app also has a direct route, so it is listed under Composio only in its full catalog. */
export function hasDirectRoute(slug: string): boolean {
  return DIRECT_COMPOSIO.has(slug)
}

/** How many curated Composio apps the All apps list shows before "Browse all Composio apps". */
export const COMPOSIO_FIRST_LOOK = 6

/** The curated Composio apps the section offers: none with a direct route, none the bot already has. */
export function curatedComposioApps(connected: ReadonlySet<string>): ComposioCuratedApp[] {
  return COMPOSIO_CURATED_APPS.filter(
    (app) => !hasDirectRoute(app.slug) && !connected.has(app.slug)
  )
}

export function matchesAppQuery(query: string, ...texts: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || texts.some((text) => text.toLocaleLowerCase().includes(needle))
}
