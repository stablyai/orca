import { useCallback, useMemo, useState } from 'react'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { PluginCatalogLayout, type PluginCatalogFilter } from './PluginCatalogLayout'
import { PluginListGroup } from './PluginListGroup'
import {
  buildPluginListEntries,
  matchesPluginSearch,
  type PluginListEntry
} from './plugin-list-entries'
import type { InstalledRowHandlers } from './PluginManagerRows'
import { PluginMarketplaceSourceDialog } from '../dialogs/PluginMarketplaceSourceDialog'
import { PluginCatalogLinkDialog } from '../dialogs/PluginCatalogLinkDialog'
import { usePluginInstallLink } from '../state/use-plugin-install-link'
import { usePluginCatalog } from '../state/use-plugin-catalog'
import { usePluginHoverPrefetch } from '../state/use-plugin-hover-prefetch'
import { usePluginInstallAction } from '../state/use-plugin-install-action'
import {
  CatalogCard,
  CatalogNotice,
  PluginCardSkeletons,
  PluginCatalogGroups,
  type CatalogCardHandlers
} from '../catalog/PluginCatalogGroups'
import { PluginListToolbar } from './PluginListToolbar'
import { PluginCategoryChips } from './PluginCategoryChips'
import {
  PluginAllInstalled,
  PluginNoMatches,
  PluginNoneInstalled,
  PluginPageMissing
} from './PluginListEmptyStates'
import { sortByAttention } from '../presentation/plugin-status-presentation'
import { usePluginAutoUpdatesStore } from '@/store/plugin-auto-updates'
import { PluginUpdateAllDialog } from '../dialogs/PluginUpdateAllDialog'
import {
  matchesPluginFilter,
  NO_PLUGIN_LIST_FILTER,
  pluginFilterSize,
  type PluginListFilter
} from './plugin-list-filter'
import { PluginDetailPage } from '../page/PluginDetailPage'
import { useOrcaVersion, type PluginPageNavigation } from '../state/use-plugin-page-navigation'
import type { PluginLogsState } from '../state/use-plugin-logs'

function resultCountLabel(count: number): string {
  return count === 1
    ? translate('auto.components.settings.PluginManager.resultCountOne', '1 plugin matches')
    : translate('auto.components.settings.PluginManager.resultCount', '{{value0}} plugins match', {
        value0: count
      })
}

/** Rows a group shows before "Show all"; search and filters show everything. 12 fills whole rows at 1–4 columns. */
export const PLUGIN_GROUP_ROW_CAP = 12

/** A capped group's rows: the first ones, plus every installed one so its switch stays in view. */
export function cappedPluginRows(rows: readonly PluginListEntry[]): PluginListEntry[] {
  return rows.filter((entry, index) => index < PLUGIN_GROUP_ROW_CAP || entry.installed)
}

type PluginManagerProps = {
  plugins: readonly PluginHostListEntry[]
  pluginsLoading: boolean
  pluginsError: string | null
  busyPluginKeys: ReadonlySet<string>
  handlers: Omit<InstalledRowHandlers, 'onOpen' | 'onViewLogs' | 'onCheckUpdate'>
  onRefreshInstalled: () => Promise<void>
  /** Reloads after an install or update and opens review for any that now need it. */
  onInstalled: (pluginKeys: string | readonly string[]) => Promise<void>
  logsByPlugin: Readonly<Record<string, PluginLogsState>>
  onShowLogs: (pluginKey: string) => void
  onOpenShortcuts: () => void
  /** Which plugin's page is open; owned by the pane, which hides its header and cards for it. */
  page: PluginPageNavigation
  sourcesOpen: boolean
  setSourcesOpen: (open: boolean) => void
  onConsent: (
    pluginKey: string,
    reviewedFingerprint: string,
    decision: 'approve' | 'keep-disabled'
  ) => Promise<void>
}

export function PluginManager({
  plugins,
  pluginsLoading,
  pluginsError,
  busyPluginKeys,
  handlers,
  onRefreshInstalled,
  onInstalled,
  logsByPlugin,
  onShowLogs,
  onOpenShortcuts,
  page,
  sourcesOpen,
  setSourcesOpen,
  onConsent
}: PluginManagerProps): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [chosenTab, setTab] = useState<PluginCatalogFilter>('all')
  const [listFilter, setListFilter] = useState<PluginListFilter>(NO_PLUGIN_LIST_FILTER)
  // Why a count: each open mounts a fresh dialog, so its previews and results start clean.
  const [updateAllOpens, setUpdateAllOpens] = useState(0)
  const [updateEntries, setUpdateEntries] = useState<readonly PluginListEntry[] | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const { openKey, open, back } = page
  const catalog = usePluginCatalog({
    onRefreshInstalled,
    onOpenRequested: open
  })
  // Why: an install counts as from a link only while the page that link opened is showing.
  const [linkedKey, setLinkedKey] = useState<string | null>(null)
  const installLink = usePluginInstallLink({
    sources: catalog.sources,
    loading: catalog.loading,
    loadMarketplaceData: catalog.loadMarketplaceData,
    open: (pluginKey) => {
      setLinkedKey(pluginKey)
      open(pluginKey)
    }
  })
  const openEntry = (pluginKey: string): void => {
    open(pluginKey)
    if (plugins.find((plugin) => plugin.pluginKey === pluginKey)?.hasWorker) {
      onShowLogs(pluginKey)
    }
  }
  const isFromInstallLink = useCallback(
    (pluginKey: string) => pluginKey === linkedKey && openKey === linkedKey,
    [linkedKey, openKey]
  )
  const install = usePluginInstallAction({
    fetchPreview: catalog.fetchPreview,
    onInstalled,
    isFromInstallLink
  })
  const prefetch = usePluginHoverPrefetch(catalog.fetchPreview)
  const orcaVersion = useOrcaVersion()
  const autoUpdated = usePluginAutoUpdatesStore((state) => state.updated)
  const autoNeedsReview = usePluginAutoUpdatesStore((state) => state.needsReview)

  const entries = useMemo(() => {
    const built = buildPluginListEntries(plugins, catalog.listings, {
      sources: catalog.sources,
      orcaVersion,
      autoUpdates: { updated: autoUpdated, needsReview: autoNeedsReview }
    })
    return {
      ...built,
      installed: sortByAttention(built.installed, (entry) => Boolean(entry.updateVersion))
    }
  }, [plugins, catalog.listings, catalog.sources, orcaVersion, autoUpdated, autoNeedsReview])
  const query = search.trim()
  const filterSize = pluginFilterSize(listFilter)
  const narrowed = Boolean(query) || filterSize > 0
  const matches = (entry: PluginListEntry): boolean =>
    matchesPluginSearch(entry, query) && matchesPluginFilter(entry, listFilter)
  const installed = entries.installed.filter(matches)
  const updates = entries.installed.filter((entry) => entry.updateVersion)
  // Why: once the last update lands the Updates filter is gone, so the list falls back to Installed.
  const filter: PluginCatalogFilter =
    chosenTab === 'updates' && updates.length === 0 ? 'installed' : chosenTab
  const visibleInstalled = filter === 'updates' ? updates.filter(matches) : installed
  const capped = (groupId: string, rows: PluginListEntry[]): PluginListEntry[] =>
    narrowed || expandedGroups.has(groupId) ? rows : cappedPluginRows(rows)
  const showAll = (groupId: string) => () =>
    setExpandedGroups((current) => new Set(current).add(groupId))
  const listedInCatalog = (entry: PluginListEntry): boolean =>
    catalog.sources.some((source) => source.id === entry.listing?.marketplaceSourceId)
  // Why: dev folders, local installs and bundled plugins have no catalog card to carry their switch.
  const uncataloged = catalog.loading ? [] : installed.filter((entry) => !listedInCatalog(entry))
  const catalogInstalled = filter === 'available' ? [] : entries.installed
  const openUpdates = (entries: readonly PluginListEntry[]): void => {
    setUpdateAllOpens((count) => count + 1)
    setUpdateEntries(entries)
  }
  const rowHandlers: InstalledRowHandlers = {
    ...handlers,
    onOpen: openEntry,
    onViewLogs: openEntry,
    onCheckUpdate: (entry) => openUpdates([entry])
  }
  const cardHandlers: CatalogCardHandlers = {
    install,
    prefetch,
    openEntry,
    orcaVersion,
    refreshing: catalog.refreshBusy,
    installedHandlers: rowHandlers,
    busyPluginKeys
  }
  const visibleCatalogCount = [
    ...entries.available,
    ...catalogInstalled.filter((entry) => entry.listing)
  ].filter((entry) => listedInCatalog(entry) && matches(entry)).length
  const resultCount =
    filter === 'installed' || filter === 'updates'
      ? visibleInstalled.length
      : visibleCatalogCount + (filter === 'all' ? uncataloged.length : 0)
  const nothingMatches = narrowed && resultCount === 0
  const everythingInstalled =
    filter === 'available' &&
    !narrowed &&
    !catalog.loading &&
    !catalog.error &&
    catalog.sources.length > 0 &&
    catalog.sources.every((source) => !source.error) &&
    visibleCatalogCount === 0

  const installedTitle = translate('auto.components.settings.PluginManager.installed', 'Installed')
  const installedGroup = pluginsLoading ? (
    <PluginListGroup layout="grid" title={installedTitle} showHeading={false}>
      <PluginCardSkeletons />
    </PluginListGroup>
  ) : pluginsError ? (
    <PluginListGroup
      title={installedTitle}
      showHeading={false}
      notice={
        <CatalogNotice
          tone="error"
          title={translate(
            'auto.components.settings.PluginManager.installedFailedTitle',
            'Couldn’t read your installed plugins.'
          )}
          body={pluginsError}
          actions={
            <Button variant="ghost" size="xs" onClick={() => void onRefreshInstalled()}>
              {translate('auto.components.settings.PluginManager.retry', 'Retry')}
            </Button>
          }
        />
      }
    />
  ) : filter === 'all' ? (
    uncataloged.length > 0 ? (
      <PluginListGroup
        layout="grid"
        title={installedTitle}
        detail={
          // Why: with no catalog loaded every installed plugin lands here, listed or not.
          catalog.sources.length > 0
            ? translate(
                'auto.components.settings.PluginManager.notFromCatalog',
                'not from a catalog'
              )
            : undefined
        }
      >
        {uncataloged.map((entry) => (
          <CatalogCard key={entry.pluginKey} entry={entry} handlers={cardHandlers} />
        ))}
      </PluginListGroup>
    ) : null
  ) : (
    <PluginListGroup
      layout="grid"
      title={
        filter === 'updates'
          ? translate('auto.components.settings.PluginManager.updatesTitle', 'Updates')
          : installedTitle
      }
      showHeading={false}
    >
      {visibleInstalled.map((entry) => (
        <CatalogCard key={entry.pluginKey} entry={entry} handlers={cardHandlers} />
      ))}
    </PluginListGroup>
  )

  const openedEntry = openKey
    ? ([...entries.installed, ...entries.available].find((entry) => entry.pluginKey === openKey) ??
      null)
    : null
  const dialogs = (
    <>
      <PluginUpdateAllDialog
        key={updateAllOpens}
        open={updateEntries !== null}
        entries={updateEntries ?? []}
        orcaVersion={orcaVersion}
        onClose={() => setUpdateEntries(null)}
        onUpdated={onInstalled}
      />
      <PluginMarketplaceSourceDialog
        open={sourcesOpen}
        sources={catalog.sources}
        onOpenChange={setSourcesOpen}
        onChanged={catalog.loadMarketplaceData}
      />
      <PluginCatalogLinkDialog
        catalog={installLink.catalogToAdd}
        onCancel={installLink.cancelCatalog}
        onConfirm={installLink.confirmCatalog}
      />
    </>
  )
  if (openKey && !openedEntry) {
    return (
      <>
        <PluginPageMissing loading={pluginsLoading || catalog.loading} onBack={back} />
        {dialogs}
      </>
    )
  }
  if (openedEntry) {
    return (
      <>
        <PluginDetailPage
          key={openedEntry.pluginKey}
          entry={openedEntry}
          busy={busyPluginKeys.has(openedEntry.pluginKey)}
          orcaVersion={orcaVersion}
          logsState={logsByPlugin[openedEntry.pluginKey]}
          handlers={rowHandlers}
          fetchPreview={catalog.fetchPreview}
          install={install}
          refreshing={catalog.refreshBusy}
          onConsent={onConsent}
          onBack={back}
          onOpenShortcuts={onOpenShortcuts}
        />
        {dialogs}
      </>
    )
  }

  return (
    <>
      <PluginCatalogLayout
        filter={filter}
        onFilterChange={setTab}
        search={search}
        onSearchChange={setSearch}
        installedCount={plugins.length}
        updateCount={updates.length}
        filters={
          <PluginCategoryChips
            entries={[...entries.installed, ...entries.available]}
            filter={listFilter}
            onChange={setListFilter}
          />
        }
        toolbar={
          <PluginListToolbar
            updateCount={filter === 'updates' ? updates.length : 0}
            onUpdateAll={() => openUpdates(updates)}
            filter={listFilter}
            sources={catalog.sources}
            onFilterChange={setListFilter}
            refreshBusy={catalog.refreshBusy}
            onRefresh={() => void catalog.refresh()}
          />
        }
      >
        {catalog.error && catalog.sources.length > 0 ? (
          <CatalogNotice
            tone="error"
            title={catalog.error}
            body=""
            actions={
              <Button variant="ghost" size="xs" onClick={() => void catalog.refresh()}>
                {translate('auto.components.settings.PluginManager.retry', 'Retry')}
              </Button>
            }
          />
        ) : null}
        {nothingMatches ? (
          <PluginNoMatches
            query={query}
            filtered={filterSize > 0}
            onClear={() => {
              setSearch('')
              setListFilter(NO_PLUGIN_LIST_FILTER)
            }}
          />
        ) : (filter === 'installed' || filter === 'updates') &&
          !pluginsLoading &&
          !pluginsError &&
          visibleInstalled.length === 0 ? (
          <PluginNoneInstalled onBrowse={() => setTab('all')} />
        ) : everythingInstalled ? (
          <PluginAllInstalled onShowInstalled={() => setTab('installed')} />
        ) : filter === 'all' || filter === 'available' ? (
          <div className="@container/plugin-catalog space-y-8">
            {/* Why the error and loading too: until installed plugins are read, Not installed can't tell what you have. */}
            {filter === 'all' || pluginsError || pluginsLoading ? installedGroup : null}
            {filter === 'available' && (pluginsLoading || pluginsError) ? null : (
              <PluginCatalogGroups
                catalog={catalog}
                available={entries.available}
                installed={catalogInstalled}
                cardHandlers={cardHandlers}
                matches={matches}
                narrowed={narrowed}
                capped={capped}
                showAll={showAll}
                openSources={() => setSourcesOpen(true)}
              />
            )}
          </div>
        ) : (
          <div className="@container/plugin-catalog">{installedGroup}</div>
        )}
        <p className="sr-only" aria-live="polite">
          {narrowed ? resultCountLabel(resultCount) : ''}
        </p>
      </PluginCatalogLayout>
      {dialogs}
    </>
  )
}
