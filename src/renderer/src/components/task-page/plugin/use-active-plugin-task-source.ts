import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { usePluginTaskSources, type ActivePluginTaskSource } from '@/store/plugin-task-sources'
import { taskPageDataRequestsBuiltin } from '@/lib/plugin-task-page-source'
import {
  isSamePluginTaskSource,
  resolveActivePluginTaskSource
} from '../../../../../shared/plugins/plugin-task-source-ref'

export type TaskPageSourceView =
  | { kind: 'builtin' }
  | { kind: 'pending' }
  | { kind: 'plugin'; source: ActivePluginTaskSource }

export function useTaskPageSourceView(): TaskPageSourceView {
  const taskPageData = useAppStore((state) => state.taskPageData)
  const savedDefault = useAppStore((state) => state.settings?.defaultPluginTaskSource)
  const { sources, ready } = usePluginTaskSources()
  return useMemo(() => {
    const resolution = resolveActivePluginTaskSource({
      requested: taskPageData.pluginTaskSource,
      requestsBuiltin: taskPageDataRequestsBuiltin(taskPageData),
      savedDefault,
      available: sources,
      availableReady: ready
    })
    if (resolution.kind !== 'plugin') {
      return resolution
    }
    const source = sources.find((candidate) => isSamePluginTaskSource(candidate, resolution.source))
    return source ? { kind: 'plugin', source } : { kind: 'builtin' }
  }, [ready, savedDefault, sources, taskPageData])
}
