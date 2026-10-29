import { useMemo, useState } from 'react'
import { Blocks } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { PluginCatalogLayout, type PluginCatalogFilter } from './PluginCatalogLayout'
import { PluginCatalogEmptyState } from './PluginCatalogEmptyState'
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
import { InstalledPluginCarousel } from '../catalog/InstalledPluginCarousel'
import { PluginListToolbar } from './PluginListToolbar'
import { PluginNoMatches, PluginPageMissing } from './PluginListEmptyStates'
import { sortByAttention } from '../presentation/plugin-status-presentation'
import { usePluginAutoUpdatesStore } from '@/store/plugin-auto-updates'
import { useAppStore } from '@/store'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import { collectActivePluginNewFiles } from '@/store/plugin-new-files'
import { openPluginNewFileFromSettings } from '../page/PluginContributionActionNewFile'
import { pluginPanelUnavailableReason } from '../page/plugin-contribution-action-availability'
import { PluginUpdateAllDialog } from '../dialogs/PluginUpdateAllDialog'
import {
  matchesPluginFilter,
  NO_PLUGIN_LIST_FILTER,
  pluginFilterCategories,
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

/** Rows a group shows before "Show N more"; search and filters show everything. */
export const PLUGIN_GROUP_ROW_CAP = 6

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
  const installLink = usePluginInstallLink({
    sources: catalog.sources,
    loading: catalog.loading,
    loadMarketplaceData: catalog.loadMarketplaceData,
    open
  })
  const openEntry = (pluginKey: string): void => {
    open(pluginKey)
    if (plugins.find((plugin) => plugin.pluginKey === pluginKey)?.hasWorker) {
      onShowLogs(pluginKey)
    }
  }
  // Why a new file: an editor plugin is tried by drawing in it, and its page is already open.
  const tryPlugin = (pluginKey: string): void => {
    const installed = usePluginPanelsStore
      .getState()
      .plugins.filter((plugin) => plugin.pluginKey === pluginKey)
    const newFile = collectActivePluginNewFiles(installed)[0]
    if (newFile && !pluginPanelUnavailableReason(useAppStore.getState())) {
      openPluginNewFileFromSettings(newFile)
      return
    }
    openEntry(pluginKey)
  }
  const install = usePluginInstallAction({
    fetchPreview: catalog.fetchPreview,
    onInstalled,
    onTryPlugin: tryPlugin
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
  // Why: once the last update lands the Updates tab is gone, so the list falls back to Installed.
  const filter: PluginCatalogFilter =
    chosenTab === 'updates' && updates.length === 0 ? 'installed' : chosenTab
  const visibleInstalled = filter === 'updates' ? updates.filter(matches) : installed
  const capped = (groupId: string, rows: PluginListEntry[]): PluginListEntry[] =>
    narrowed || expandedGroups.has(groupId) ? rows : rows.slice(0, PLUGIN_GROUP_ROW_CAP)
  const showAll = (groupId: string) => () =>
    setExpandedGroups((current) => new Set(current).add(groupId))

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
  const visibleAvailableCount = [
    ...entries.available,
    ...entries.installed.filter((entry) => entry.listing)
  ].filter(
    (entry) =>
      catalog.sources.some((source) => source.id === entry.listing?.marketplaceSourceId) &&
      matches(entry)
  ).length
  const nothingMatches =
    narrowed && visibleInstalled.length === 0 && (filter !== 'all' || visibleAvailableCount === 0)

  const installedGroup = pluginsLoading ? (
    <PluginListGroup
      layout="grid"
      title={translate('auto.components.settings.PluginManager.installed', 'Installed')}
      showHeading={false}
    >
      <PluginCardSkeletons />
    </PluginListGroup>
  ) : pluginsError ? (
    <PluginListGroup
      title={translate('auto.components.settings.PluginManager.installed', 'Installed')}
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
    <InstalledPluginCarousel
      entries={visibleInstalled}
      handlers={cardHandlers}
      onSeeAll={() => setTab('installed')}
    />
  ) : (
    <PluginListGroup
      layout="grid"
      title={
        filter === 'updates'
          ? translate('auto.components.settings.PluginManager.updatesTitle', 'Updates')
          : translate('auto.components.settings.PluginManager.installed', 'Installed')
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
        toolbar={
          <PluginListToolbar
            updateCount={filter === 'updates' ? updates.length : 0}
            onUpdateAll={() => openUpdates(updates)}
            filter={listFilter}
            categories={pluginFilterCategories([...entries.installed, ...entries.available])}
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
        ) : filter !== 'all' &&
          !pluginsLoading &&
          !pluginsError &&
          visibleInstalled.length === 0 ? (
          <PluginCatalogEmptyState
            icon={Blocks}
            title={translate(
              'auto.components.settings.PluginManager.noneInstalledTitle',
              'No plugins installed'
            )}
            action={
              <Button variant="outline" size="sm" onClick={() => setTab('all')}>
                {translate(
                  'auto.components.settings.PluginManager.browseAll',
                  'Browse all plugins'
                )}
              </Button>
            }
          />
        ) : filter === 'all' ? (
          <div className="@container/plugin-catalog space-y-8">
            {installedGroup}
            <PluginCatalogGroups
              catalog={catalog}
              available={entries.available}
              installed={entries.installed}
              cardHandlers={cardHandlers}
              matches={matches}
              narrowed={narrowed}
              capped={capped}
              showAll={showAll}
              openSources={() => setSourcesOpen(true)}
            />
          </div>
        ) : (
          <div className="@container/plugin-catalog">{installedGroup}</div>
        )}
        <p className="sr-only" aria-live="polite">
          {narrowed
            ? resultCountLabel(
                visibleInstalled.length + (filter === 'all' ? visibleAvailableCount : 0)
              )
            : ''}
        </p>
      </PluginCatalogLayout>
      {dialogs}
    </>
  )
}
