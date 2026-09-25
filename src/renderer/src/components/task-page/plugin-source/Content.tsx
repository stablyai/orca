import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { TaskPagePluginSourceList } from './List'
import { usePluginTaskItemWorkspaceSeed } from './workspace-seed'

export function TaskPagePluginSourceContent(): React.JSX.Element {
  const onUseItem = usePluginTaskItemWorkspaceSeed()
  const selected = useAppStore((state) => state.selectedPluginTaskSource)
  const sources = useAppStore((state) => state.pluginTaskSources)
  const items = useAppStore((state) => state.pluginTaskSourceItems)
  const loading = useAppStore((state) => state.pluginTaskSourceLoading)
  const error = useAppStore((state) => state.pluginTaskSourceError)
  const filters = useAppStore((state) => state.pluginTaskSourceFilters)
  const facets = useAppStore((state) => state.pluginTaskSourceFacets)
  const facetOptions = useAppStore((state) => state.pluginTaskSourceFacetOptions)
  const query = useAppStore((state) => state.pluginTaskSourceQuery)
  const setQuery = useAppStore((state) => state.setPluginTaskSourceQuery)
  const scopes = useAppStore((state) => state.pluginTaskSourceScopes)
  const scopesLoading = useAppStore((state) => state.pluginTaskSourceScopesLoading)
  const scopesError = useAppStore((state) => state.pluginTaskSourceScopesError)
  const selectedScopeIds = useAppStore((state) => state.selectedPluginTaskSourceScopeIds)
  const setScopeIds = useAppStore((state) => state.setPluginTaskSourceScopeIds)
  const loadStatus = useAppStore((state) => state.loadPluginTaskSourceStatus)
  const loadScopes = useAppStore((state) => state.loadPluginTaskSourceScopes)
  const loadItems = useAppStore((state) => state.loadPluginTaskSourceItems)
  const loadFacetOptions = useAppStore((state) => state.loadPluginTaskSourceFacetOptions)
  const refreshing = useAppStore((state) => state.pluginTaskSourceRefreshing)
  const refresh = useAppStore((state) => state.refreshPluginTaskSource)
  const supportsCreate = useAppStore((state) => state.pluginTaskSourceSupportsCreate)
  const listItemTypes = useAppStore((state) => state.listPluginTaskSourceItemTypes)
  const createItem = useAppStore((state) => state.createPluginTaskSourceItem)

  useEffect(() => {
    void loadStatus()
  }, [loadStatus, selected])

  useEffect(() => {
    void loadScopes()
  }, [loadScopes, selected])

  // Options are per scope — a sprint or a state belongs to the project it came
  // from — so a changed scope selection refetches them rather than leaving the
  // previous project's options on screen.
  useEffect(() => {
    void loadFacetOptions()
  }, [loadFacetOptions, selected, facets, selectedScopeIds])

  // The request carries only facets whose options have settled, so the load
  // that races a scope change sends none of them. Once they all settle this
  // flips once and the list reloads with them — without it, a selection that
  // survives the new scope is never applied, because nothing else changes.
  //
  // False, not vacuously true, before any facet is declared: the effect below
  // runs on mount regardless, and this only governs re-runs. Were it true then,
  // the arrival of the declarations would flip it false and fire a second
  // unfiltered load between the mount one and the settled one. A source that
  // declares no facets simply never re-runs on it, which is correct — there is
  // nothing to wait for.
  const facetsSettled =
    facets.length > 0 &&
    facets.every((facet) => (facetOptions[facet.id]?.status ?? 'loading') !== 'loading')

  // The query and the scope selection are both part of the request, so a chip,
  // a debounced search, or a picked project lands here as one reload rather
  // than a second code path.
  useEffect(() => {
    void loadItems()
  }, [loadItems, selected, query, selectedScopeIds, facetsSettled])

  const scopeFilter = useMemo(
    () => ({
      scopes,
      selectedScopeIds,
      loading: scopesLoading,
      error: scopesError,
      onScopeIdsChange: setScopeIds
    }),
    [scopes, scopesLoading, scopesError, selectedScopeIds, setScopeIds]
  )

  const create = useMemo(
    () => (supportsCreate ? { listItemTypes, createItem, onCreated: () => void refresh() } : null),
    [supportsCreate, listItemTypes, createItem, refresh]
  )

  const contributed = sources.find(
    (source) => source.pluginKey === selected?.pluginKey && source.sourceId === selected?.sourceId
  )
  return (
    <TaskPagePluginSourceList
      key={selected ? `${selected.pluginKey}:${selected.sourceId}` : 'none'}
      title={contributed?.title ?? selected?.sourceId ?? ''}
      items={items}
      loading={loading}
      error={error}
      filters={filters}
      facets={facets}
      facetOptions={facetOptions}
      query={query}
      onQueryChange={setQuery}
      scopeFilter={scopeFilter}
      onUseItem={onUseItem}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      create={create}
    />
  )
}
