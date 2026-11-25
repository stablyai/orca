// Add an MCP server's list: the catalog in one grid (the chips filter it), the host's own servers
// under "N added", and Custom server for anything else.
import React from 'react'
import { Link2 } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { BotAppBrandLogo } from '@/components/bots/apps/BotAppBrandLogo'
import {
  BotAppCaption,
  BotAppGrid,
  BotAppLogo,
  BotAppRow,
  BotAppRowButton
} from '@/components/bots/apps/BotAppRow'
import { ManageButton } from '@/components/bots/apps/BotAppsRows'
import { BotToolLogo } from '@/components/bots/apps/BotToolAppRow'
import { matchesAppQuery } from '@/components/bots/apps/bot-app-catalog'
import type { AppsView } from '@/components/bots/apps/BotAppsChips'
import { botMcpAppLine } from '../../../../../shared/bots/bot-app-lines'
import {
  MCP_SERVER_CATALOG_CATEGORIES,
  type McpServerCatalogCategory,
  type McpServerCatalogEntry
} from '../../../../../shared/mcp-servers/mcp-server-catalog'
import type { McpServerView } from '@/runtime/mcp-servers/mcp-servers-client'
import { mcpServerLine, mcpServerTitle } from './mcp-server-words'

export type McpCatalogView = AppsView<McpServerCatalogCategory>

// GitHub and Linear are connectors on bots, with other lines there, so theirs are keyed apart.
export function mcpCatalogLine(entry: McpServerCatalogEntry, t: Translate): string {
  switch (entry.id) {
    case 'github':
      return t('settings.mcpServers.catalogLine.github', 'Issues, pull requests and code search')
    case 'linear':
      return t('settings.mcpServers.catalogLine.linear', 'Read and update issues and projects')
    default:
      return botMcpAppLine(entry, t)
  }
}

export function mcpCategoryName(category: McpServerCatalogCategory, t: Translate): string {
  switch (category) {
    case 'coding':
      return t('bots.apps.category.coding', 'Coding')
    case 'chat':
      return t('bots.apps.category.chat', 'Chat')
    case 'monitoring':
      return t('bots.apps.category.monitoring', 'Monitoring')
    case 'docs':
      return t('bots.apps.category.docs', 'Docs and projects')
    case 'more':
      return t('bots.apps.chip.more', 'More')
  }
}

/** The host's server an entry is on as, by its name or its address. */
export function mcpCatalogServer(
  entry: McpServerCatalogEntry,
  servers: readonly McpServerView[]
): McpServerView | undefined {
  return servers.find((server) => server.name === entry.id || server.detail === entry.url)
}

export function McpServersCatalog({
  view,
  query,
  entries,
  servers,
  onAdd,
  onCustom,
  onManage,
  noMatch
}: {
  view: McpCatalogView
  query: string
  entries: readonly McpServerCatalogEntry[]
  servers: readonly McpServerView[]
  onAdd: (entry: McpServerCatalogEntry) => void
  onCustom: () => void
  onManage: (server: McpServerView) => void
  noMatch: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const entryRow = (entry: McpServerCatalogEntry): React.JSX.Element => {
    const server = mcpCatalogServer(entry, servers)
    return (
      <BotAppRow
        key={entry.id}
        logo={<BotAppBrandLogo app={entry} size="catalog" />}
        added={server !== undefined}
        name={entry.name}
        line={mcpCatalogLine(entry, t)}
        action={
          server ? (
            <ManageButton name={entry.name} onClick={() => onManage(server)} />
          ) : (
            <BotAppRowButton onClick={() => onAdd(entry)}>
              {t('bots.apps.add', 'Add')}
            </BotAppRowButton>
          )
        }
      />
    )
  }
  const customName = t('settings.mcpServers.custom.title', 'Custom server')
  const customLine = t('settings.mcpServers.custom.line', 'A URL, a start command or a config')
  const customRow = (
    <BotAppRow
      key="custom"
      logo={<BotAppLogo plain icon={<Link2 className="size-5" />} size="catalog" />}
      name={customName}
      line={customLine}
      action={<BotAppRowButton onClick={onCustom}>{t('bots.apps.add', 'Add')}</BotAppRowButton>}
    />
  )
  const section = (title: string, rows: React.ReactNode[]): React.JSX.Element =>
    rows.length === 0 ? (
      <>{noMatch}</>
    ) : (
      <section aria-label={title}>
        <BotAppCaption title={title} count={rows.length} />
        <BotAppGrid>{rows}</BotAppGrid>
      </section>
    )

  if (view === 'mine') {
    const mine = servers.filter((server) =>
      matchesAppQuery(query, mcpServerTitle(server.name), mcpServerLine(server))
    )
    return section(
      t('bots.apps.addedCaption', 'Added'),
      mine.map((server) => (
        <BotAppRow
          key={server.id}
          logo={<BotToolLogo name={server.name} detail={server.detail} />}
          added
          name={mcpServerTitle(server.name)}
          line={mcpServerLine(server)}
          action={
            <ManageButton name={mcpServerTitle(server.name)} onClick={() => onManage(server)} />
          }
        />
      ))
    )
  }
  if (view === 'custom') {
    return section(
      t('bots.apps.custom.name', 'Custom'),
      matchesAppQuery(query, customName, customLine) ? [customRow] : []
    )
  }
  const inView = entries.filter(
    (entry) =>
      (view === 'all' || entry.category === view) &&
      matchesAppQuery(query, entry.name, mcpCatalogLine(entry, t))
  )
  // One grid in category order: the chips do the grouping.
  const ordered = MCP_SERVER_CATALOG_CATEGORIES.flatMap((category) =>
    inView.filter((entry) => entry.category === category)
  )
  const rows = ordered.map(entryRow)
  if (view === 'all' && matchesAppQuery(query, customName, customLine) && query.trim() !== '') {
    rows.push(customRow)
  }
  return section(
    view === 'all'
      ? t('settings.mcpServers.catalog.caption', 'Servers')
      : view === 'composio' || view === 'catalog'
        ? ''
        : mcpCategoryName(view, t),
    rows
  )
}
