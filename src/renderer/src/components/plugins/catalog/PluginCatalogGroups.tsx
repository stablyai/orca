import { AlertTriangle, CircleAlert } from 'lucide-react'
import type { PluginMarketplaceHostSourceState } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { Button } from '../../ui/button'
import { PluginListGroup } from '../list/PluginListGroup'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { PluginCard } from '../list/PluginCard'
import { PluginChips } from '../list/PluginChips'
import { PluginCardAction } from './PluginCardAction'
import { Badge } from '../../ui/badge'
import { PluginCategoryBadge } from '../list/PluginCategoryBadge'
import { usePluginArtPalettes } from '../state/use-plugin-art-palettes'
import { installedPluginControls, type InstalledRowHandlers } from '../list/PluginManagerRows'
import type { usePluginCatalog } from '../state/use-plugin-catalog'
import type { usePluginHoverPrefetch } from '../state/use-plugin-hover-prefetch'
import type { usePluginInstallAction } from '../state/use-plugin-install-action'

function sourceDetail(source: PluginMarketplaceHostSourceState): string {
  const trust = source.official
    ? translate('auto.components.settings.PluginManager.verified', 'verified')
    : translate('auto.components.settings.PluginManager.unverified', 'unverified')
  const origin = source.official ? source.marketplace?.owner : source.source.url
  return origin ? `${trust} · ${origin}` : trust
}

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

/** One group per catalog source, each capped, with its own refresh or load failure. */
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
  /** Search or a filter is on: show every match and hide groups with none. */
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
  const availableBySource = catalog.sources.map((source) => {
    const rows = listed
      .filter((entry) => entry.listing?.marketplaceSourceId === source.id && matches(entry))
      .sort((left, right) => rank(left) - rank(right))
    return { source, rows }
  })
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
      {availableBySource.map(({ source, rows }) => {
        const shown = capped(source.id, rows)
        const listedTotal = listed.filter(
          (entry) => entry.listing?.marketplaceSourceId === source.id
        ).length
        if (narrowed && rows.length === 0) {
          return null
        }
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
        return (
          <PluginListGroup
            key={source.id}
            layout="grid"
            title={source.marketplace?.name ?? source.source.url}
            detail={sourceDetail(source)}
            aside={
              listedTotal > shown.length && !narrowed
                ? translate(
                    'auto.components.settings.PluginManager.shownOf',
                    '{{value0}} of {{value1}}',
                    {
                      value0: shown.length,
                      value1: listedTotal
                    }
                  )
                : undefined
            }
            notice={notice}
            hiddenCount={rows.length - shown.length}
            totalCount={rows.length}
            onShowAll={showAll(source.id)}
          >
            {shown.length > 0
              ? shown.map((entry) => (
                  <CatalogCard
                    key={`${source.id}:${entry.pluginKey}`}
                    entry={entry}
                    handlers={cardHandlers}
                  />
                ))
              : null}
          </PluginListGroup>
        )
      })}
    </>
  )
}
