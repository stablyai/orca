import { AlertTriangle, CircleAlert } from 'lucide-react'
import type { PluginMarketplaceHostSourceState } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { Button } from '../ui/button'
import type { PluginCatalogFilter } from '../plugin-catalog/PluginCatalogLayout'
import { PluginListGroup } from '../plugin-catalog/PluginListGroup'
import type { PluginListEntry } from '../plugin-catalog/plugin-list-entries'
import { PluginCard } from '../plugin-catalog/PluginCard'
import { PluginChips } from '../plugin-catalog/PluginChips'
import { PluginCardAction } from './PluginCardAction'
import { Badge } from '../ui/badge'
import { PLUGIN_CONTRIBUTION_SUMMARY_LIMIT } from '../../../../shared/plugins/plugin-contribution-summary'
import { pluginPointsFromSummary, pluginTrust } from './plugin-access-profile'
import { pluginTrustLabel } from './plugin-consent-copy'
import { installedPluginPresentation } from './plugin-status-presentation'
import { usePluginArtPalettes } from './use-plugin-art-palettes'
import type { InstalledRowHandlers } from './PluginManagerRows'
import type { usePluginCatalog } from './use-plugin-catalog'
import type { usePluginHoverPrefetch } from './use-plugin-hover-prefetch'
import type { usePluginInstallAction } from './use-plugin-install-action'

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
  actions,
  standalone = false
}: {
  tone: 'warning' | 'error'
  title: string
  body: string
  actions: React.ReactNode
  /** Its own card, not a strip under a group heading. */
  standalone?: boolean
}): React.JSX.Element {
  const Icon = tone === 'warning' ? AlertTriangle : CircleAlert
  return (
    <div
      role="status"
      data-tone={tone}
      data-standalone={standalone}
      className="flex items-start gap-2.5 border-t border-border px-4 py-2.5 text-xs data-[standalone=true]:rounded-xl data-[standalone=true]:border data-[standalone=true]:border-border/50 data-[standalone=true]:bg-card/50 data-[tone=warning]:bg-status-warning/7"
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
  /** Requests confirmation before deleting plugin data. */
  onRemove: (pluginKey: string) => void
  onToggleEnabled: (pluginKey: string) => void
}

function CatalogCard({
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
  // Why the summary only below its cap: a capped list can't rule a command out.
  const trustLabel = release
    ? pluginTrustLabel(
        pluginTrust({
          execution: release.execution,
          points:
            release.contributes && release.contributes.length < PLUGIN_CONTRIBUTION_SUMMARY_LIMIT
              ? pluginPointsFromSummary(release.contributes)
              : null
        })
      )
    : null
  const statusText = installed
    ? installedPluginPresentation(installed, entry.updateVersion).statusText
    : undefined
  return (
    <PluginCard
      entry={entry}
      statusText={statusText}
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
            : undefined
      }
      chips={
        <>
          {trustLabel ? <Badge variant="hostContext">{trustLabel}</Badge> : null}
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
          onRemove={() => handlers.onRemove(entry.pluginKey)}
          onToggleEnabled={() => handlers.onToggleEnabled(entry.pluginKey)}
        />
      }
    />
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
  filter,
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
  filter: PluginCatalogFilter
  capped: (groupId: string, rows: PluginListEntry[]) => PluginListEntry[]
  showAll: (groupId: string) => () => void
  openSources: () => void
}): React.JSX.Element | null {
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
  return filter !== 'all' ? null : catalog.loading ? (
    <PluginListGroup
      layout="grid"
      title={translate('auto.components.settings.PluginManager.catalogLoading', 'Catalog')}
    >
      {[0, 1, 2].map((index) => (
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
    </PluginListGroup>
  ) : catalog.error && catalog.sources.length === 0 ? (
    <PluginListGroup
      layout="grid"
      title={translate('auto.components.settings.PluginManager.catalogLoading', 'Catalog')}
      notice={
        <CatalogNotice
          standalone
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
              standalone
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
              standalone
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
