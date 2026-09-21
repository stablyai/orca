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
  const loadItems = useAppStore((state) => state.loadPluginTaskSourceItems)
  useEffect(() => {
    void loadItems()
  }, [loadItems, selected])
  const contributed = sources.find(
    (source) => source.pluginKey === selected?.pluginKey && source.sourceId === selected?.sourceId
  )
  return (
    <TaskPagePluginSourceList
      title={contributed?.title ?? selected?.sourceId ?? ''}
      items={items}
      loading={loading}
      error={error}
      onUseItem={onUseItem}
    />
  )
}
