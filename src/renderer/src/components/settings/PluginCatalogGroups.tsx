import { AlertTriangle, CircleAlert } from 'lucide-react'
import type { PluginMarketplaceHostSourceState } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { Button } from '../ui/button'
import type { PluginCatalogFilter } from '../plugin-catalog/PluginCatalogLayout'
import { PluginListGroup } from '../plugin-catalog/PluginListGroup'
import { PluginListSkeleton } from '../plugin-catalog/PluginListSkeleton'
import type { PluginListEntry } from '../plugin-catalog/plugin-list-entries'
import { AvailablePluginRow } from './PluginManagerRows'
import type { usePluginCatalog } from './use-plugin-catalog'

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

/** One group per catalog source, each capped, with its own refresh or load failure. */
export function PluginCatalogGroups({
  catalog,
  available,
  matches,
  narrowed,
  filter,
  capped,
  showAll,
  openEntry,
  openSources,
  orcaVersion
}: {
  catalog: ReturnType<typeof usePluginCatalog>
  available: readonly PluginListEntry[]
  matches: (entry: PluginListEntry) => boolean
  /** Search or a filter is on: show every match and hide groups with none. */
  narrowed: boolean
  filter: PluginCatalogFilter
  capped: (groupId: string, rows: PluginListEntry[]) => PluginListEntry[]
  showAll: (groupId: string) => () => void
  openEntry: (pluginKey: string) => void
  openSources: () => void
  orcaVersion: string | null
}): React.JSX.Element | null {
  const availableBySource = catalog.sources.map((source) => {
    const rows = available.filter(
      (entry) => entry.listing?.marketplaceSourceId === source.id && matches(entry)
    )
    return { source, rows }
  })
  return filter !== 'all' ? null : catalog.loading ? (
    <PluginListGroup
      title={translate('auto.components.settings.PluginManager.catalogLoading', 'Catalog')}
    >
      <PluginListSkeleton rows={3} />
    </PluginListGroup>
  ) : catalog.error && catalog.sources.length === 0 ? (
    <PluginListGroup
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
        const listedTotal = available.filter(
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
                  <AvailablePluginRow
                    key={`${source.id}:${entry.pluginKey}`}
                    entry={entry}
                    busy={catalog.previewBusyKey === entry.pluginKey}
                    orcaVersion={orcaVersion}
                    onOpen={(target) => openEntry(target.pluginKey)}
                    onInstall={(target) => {
                      if (target.listing) {
                        void catalog.openPreview(target.listing, false)
                      }
                    }}
                  />
                ))
              : null}
          </PluginListGroup>
        )
      })}
    </>
  )
}
