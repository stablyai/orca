import { AlertTriangle, CircleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { Button } from '../../ui/button'
import { PluginListGroup } from '../list/PluginListGroup'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginCard } from '../list/PluginCard'
import { PluginChips } from '../list/PluginChips'
import { PluginCardAction } from './PluginCardAction'
import { Badge } from '../../ui/badge'
import { pluginCategoryLabel } from '../list/plugin-category-label'
import { groupPluginsByCategory } from '../list/plugin-list-filter'
import { PluginCategoryBadge } from '../list/PluginCategoryBadge'
import { usePluginArtPalettes } from '../state/use-plugin-art-palettes'
import { installedPluginControls, type InstalledRowHandlers } from '../list/PluginManagerRows'
import type { usePluginCatalog } from '../state/use-plugin-catalog'
import type { usePluginHoverPrefetch } from '../state/use-plugin-hover-prefetch'
import type { usePluginInstallAction } from '../state/use-plugin-install-action'

export function CatalogNotice({
  tone,
  title,
  body,
  actions
}: {
  tone: 'warning' | 'error'
  title: string
  body: string
  actions: React.ReactNode
}): React.JSX.Element {
  const Icon = tone === 'warning' ? AlertTriangle : CircleAlert
  return (
    <div
      role="status"
      data-tone={tone}
      className="flex items-start gap-2.5 rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 text-xs data-[tone=warning]:bg-status-warning/7"
    >
      <Icon
        data-tone={tone}
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground data-[tone=warning]:text-status-warning"
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 leading-5">
        <span className="font-medium text-foreground">{title}</span>{' '}
        <span className="text-muted-foreground">{body}</span>
      </p>
      <div className="-my-0.5 flex shrink-0 gap-1">{actions}</div>
    </div>
  )
}

export type CatalogCardHandlers = {
  install: ReturnType<typeof usePluginInstallAction>
  prefetch: ReturnType<typeof usePluginHoverPrefetch>
  openEntry: (pluginKey: string) => void
  installedHandlers: InstalledRowHandlers
  busyPluginKeys: ReadonlySet<string>
  orcaVersion: string | null
  /** A catalog refresh is in flight; installs wait for it. */
  refreshing: boolean
}

export function CatalogCard({
  entry,
  handlers
}: {
  entry: PluginListEntry
  handlers: CatalogCardHandlers
}): React.JSX.Element {
  const palettes = usePluginArtPalettes(entry.pluginKey, entry.listing?.release?.themePreview)
  const phase = handlers.install.phaseOf(entry.pluginKey)
  const listing = entry.listing
  const installed = entry.installed
  const release = listing?.release
  // Why only full access: it is the one trust level worth a chip; the page's access section says the rest.
  const fullAccess =
    (installed?.execution ?? release?.execution) === 'trusted-worker' || installed?.hasWorker
  const controls = installed
    ? installedPluginControls(installed, entry, {
        busy: handlers.busyPluginKeys.has(entry.pluginKey),
        canCheckUpdate: entry.updatable,
        handlers: handlers.installedHandlers
      })
    : null
  const installError =
    controls?.tone === 'destructive' && typeof controls.description === 'string'
      ? controls.description
      : null
  return (
    <PluginCard
      entry={entry}
      statusText={controls?.statusText}
      palettes={palettes}
      notice={
        phase?.kind === 'error'
          ? { text: phase.message, tone: 'destructive' }
          : listing?.blockedByKillList && !entry.installed
            ? {
                text: translate(
                  'auto.components.settings.PluginMarketplaceListingRow.blocked',
                  "Blocked by Orca's safety list: {{value0}}",
                  { value0: listing.blockedByKillList.reason }
                ),
                tone: 'destructive'
              }
            : installError
              ? { text: installError, tone: 'destructive' }
              : undefined
      }
      chips={
        <>
          <PluginCategoryBadge entry={entry} />
          {fullAccess ? (
            <Badge variant="hostContext">
              {translate('auto.components.settings.pluginConsentCopy.fullAccess', 'Full access')}
            </Badge>
          ) : null}
          <PluginChips entry={entry} />
        </>
      }
      onOpen={() => handlers.openEntry(entry.pluginKey)}
      onIntent={listing && !entry.installed ? () => handlers.prefetch.intend(listing) : undefined}
      onIntentEnd={handlers.prefetch.cancel}
      action={
        <PluginCardAction
          entry={entry}
          phase={phase}
          orcaVersion={handlers.orcaVersion}
          refreshing={handlers.refreshing}
          onInstall={() => {
            if (listing) {
              void handlers.install.install(listing)
            }
          }}
          onOpen={() => handlers.openEntry(entry.pluginKey)}
          busy={handlers.busyPluginKeys.has(entry.pluginKey)}
          installedHandlers={handlers.installedHandlers}
        />
      }
    />
  )
}

/** Card placeholders with the real card geometry, so the grid doesn't jump when data lands. */
export function PluginCardSkeletons(): React.JSX.Element {
  return (
    <>
      {[0, 1, 2, 3].map((index) => (
        <li
          key={index}
          aria-hidden="true"
          className="overflow-hidden rounded-xl border border-border/70 bg-card"
        >
          <div className="aspect-[16/10] border-b border-border/70 bg-muted/60" />
          <div className="space-y-2 px-3.5 py-3">
            <div className="h-3.5 w-1/2 rounded bg-muted" />
            <div className="h-3 w-1/3 rounded bg-muted" />
            <div className="h-9 rounded bg-muted/60" />
          </div>
        </li>
      ))}
    </>
  )
}

/** Category previews share the catalog cards and preserve each source’s load notices. */
export function PluginCatalogGroups({
  catalog,
  available,
  installed,
  cardHandlers,
  matches,
  narrowed,
  capped,
  showAll,
  openSources
}: {
  catalog: ReturnType<typeof usePluginCatalog>
  available: readonly PluginListEntry[]
  /** Installed plugins keep their card, in catalog order, so installing never moves it. */
  installed: readonly PluginListEntry[]
  cardHandlers: CatalogCardHandlers
  matches: (entry: PluginListEntry) => boolean
  /** Search and filters show each matching plugin once, without category previews. */
  narrowed: boolean
  capped: (groupId: string, rows: PluginListEntry[]) => PluginListEntry[]
  showAll: (groupId: string) => () => void
  openSources: () => void
}): React.JSX.Element {
  const order = new Map(
    catalog.listings.map((listing, index) => [
      `${listing.marketplaceSourceId}:${listing.pluginKey}`,
      index
    ])
  )
  const rank = (entry: PluginListEntry): number =>
    order.get(`${entry.listing?.marketplaceSourceId}:${entry.pluginKey}`) ?? Number.MAX_SAFE_INTEGER
  const listed = [...installed.filter((entry) => entry.listing), ...available]
  const sourceCounts = new Map(catalog.sources.map((source) => [source.id, 0]))
  for (const entry of listed) {
    const sourceId = entry.listing?.marketplaceSourceId
    if (sourceId !== undefined && sourceCounts.has(sourceId)) {
      sourceCounts.set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1)
    }
  }
  const rows = listed
    .filter((entry) => sourceCounts.has(entry.listing?.marketplaceSourceId ?? '') && matches(entry))
    .sort((left, right) => rank(left) - rank(right))
  const groups = narrowed
    ? []
    : groupPluginsByCategory(rows).map(({ category, rows }) => ({
        id: category === null ? 'uncategorized' : `category:${category}`,
        title:
          category === null
            ? translate('auto.components.plugins.categories.other', 'More plugins')
            : pluginCategoryLabel(category),
        description:
          category === null
            ? translate(
                'auto.components.plugins.categories.otherDescription',
                'Discover more ways to customize Orca.'
              )
            : pluginCategoryDescription(category),
        rows
      }))
  return catalog.loading ? (
    <PluginListGroup
      layout="grid"
      title={translate('auto.components.settings.PluginManager.catalogLoading', 'Catalog')}
    >
      <PluginCardSkeletons />
    </PluginListGroup>
  ) : catalog.error && catalog.sources.length === 0 ? (
    <PluginListGroup
      layout="grid"
      title={translate('auto.components.settings.PluginManager.catalogLoading', 'Catalog')}
      notice={
        <CatalogNotice
          tone="error"
          title={translate(
            'auto.components.settings.PluginManager.catalogFailedTitle',
            'Couldn’t load the plugin catalog.'
          )}
          body={translate(
            'auto.components.settings.PluginManager.catalogFailedBody',
            'Your installed plugins keep working.'
          )}
          actions={
            <Button variant="ghost" size="xs" onClick={() => void catalog.loadMarketplaceData()}>
              {translate('auto.components.settings.PluginManager.retry', 'Retry')}
            </Button>
          }
        />
      }
    />
  ) : (
    <>
      {catalog.sources.map((source) => {
        const listedTotal = sourceCounts.get(source.id) ?? 0
        const failed = Boolean(source.error)
        const notice =
          failed && listedTotal === 0 ? (
            <CatalogNotice
              tone="error"
              title={translate(
                'auto.components.settings.PluginManager.sourceFailedTitle',
                'Couldn’t load this catalog.'
              )}
              body={translate(
                'auto.components.settings.PluginManager.sourceFailedBody',
                'Your installed plugins keep working.'
              )}
              actions={
                <>
                  <Button variant="ghost" size="xs" onClick={() => void catalog.refresh()}>
                    {translate('auto.components.settings.PluginManager.retry', 'Retry')}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => openSources()}>
                    {translate('auto.components.settings.PluginManager.sources', 'Sources…')}
                  </Button>
                </>
              }
            />
          ) : failed || source.stale ? (
            <CatalogNotice
              tone="warning"
              title={translate(
                'auto.components.settings.PluginManager.sourceStaleTitle',
                'Couldn’t refresh this catalog.'
              )}
              body={
                source.marketplace
                  ? translate(
                      'auto.components.settings.PluginManager.sourceStaleBody',
                      'Showing the copy from {{value0}}.',
                      { value0: formatShortTimeAgo(source.marketplace.fetchedAt) }
                    )
                  : ''
              }
              actions={
                <Button variant="ghost" size="xs" onClick={() => void catalog.refresh()}>
                  {translate('auto.components.settings.PluginManager.retry', 'Retry')}
                </Button>
              }
            />
          ) : null
        return notice ? (
          <section key={source.id} aria-label={source.marketplace?.name ?? source.source.url}>
            <p className="mb-2 text-xs text-muted-foreground">
              {source.marketplace?.name ?? source.source.url}
            </p>
            {notice}
          </section>
        ) : null
      })}
      {narrowed ? (
        <PluginListGroup
          layout="grid"
          title={translate('auto.components.plugins.categories.results', 'Catalog')}
        >
          {rows.map((entry) => (
            <CatalogCard key={entry.pluginKey} entry={entry} handlers={cardHandlers} />
          ))}
        </PluginListGroup>
      ) : (
        groups.map((group) => {
          const shown = capped(group.id, group.rows)
          return (
            <PluginListGroup
              key={group.id}
              layout="grid"
              categoryPreview
              title={group.title}
              description={group.description}
              hiddenCount={group.rows.length - shown.length}
              totalCount={group.rows.length}
              onShowAll={showAll(group.id)}
            >
              {shown.map((entry) => (
                <CatalogCard key={entry.pluginKey} entry={entry} handlers={cardHandlers} />
              ))}
            </PluginListGroup>
          )
        })
      )}
    </>
  )
}

function pluginCategoryDescription(category: string): string | undefined {
  switch (category) {
    case 'themes':
      return translate(
        'auto.components.plugins.categories.themesDescription',
        'Find a new look for your editor and terminal.'
      )
    case 'languages':
      return translate(
        'auto.components.plugins.categories.languagesDescription',
        'Syntax highlighting and interface languages.'
      )
    case 'icons':
      return translate(
        'auto.components.plugins.categories.iconsDescription',
        'Give your files and folders a fresh set of icons.'
      )
    case 'commands':
      return translate(
        'auto.components.plugins.categories.commandsDescription',
        'Extend your workflow with commands, panels, and editors.'
      )
    case 'machines':
      return translate(
        'auto.components.plugins.categories.machinesDescription',
        'Set up environments for your workspaces.'
      )
    default:
      return undefined
  }
}
