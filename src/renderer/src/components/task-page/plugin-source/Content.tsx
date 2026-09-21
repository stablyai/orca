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

  // The query and the scope selection are both part of the request, so a chip,
  // a debounced search, or a picked project lands here as one reload rather
  // than a second code path.
  useEffect(() => {
    void loadItems()
  }, [loadItems, selected, query, selectedScopeIds])

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
