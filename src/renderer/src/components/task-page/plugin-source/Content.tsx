import { useEffect } from 'react'
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
  const loadFilters = useAppStore((state) => state.loadPluginTaskSourceFilters)
  const loadItems = useAppStore((state) => state.loadPluginTaskSourceItems)

  useEffect(() => {
    void loadFilters()
  }, [loadFilters, selected])

  // The query is part of the request, so a chip or a debounced search lands
  // here as one reload rather than a second code path.
  useEffect(() => {
    void loadItems()
  }, [loadItems, selected, query])

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
      onUseItem={onUseItem}
    />
  )
}
