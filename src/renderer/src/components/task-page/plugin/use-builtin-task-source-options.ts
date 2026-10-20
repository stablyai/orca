import { useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider
} from '../../../../../shared/task-providers'
import { getSourceOptions } from '../../task-page-localized-options'

/** Built-in source tabs for the plugin page, filtered the same way the built-in page filters them. */
export function useVisibleBuiltinTaskSourceOptions(): ReturnType<typeof getSourceOptions> {
  const visibleTaskProviders = useAppStore((state) => state.settings?.visibleTaskProviders)
  const defaultTaskSource = useAppStore((state) => state.settings?.defaultTaskSource)
  const gitlabInstalled = useAppStore((state) => state.preflightStatus?.glab?.installed === true)
  const linearConnected = useAppStore((state) => state.linearStatus?.connected === true)
  return useMemo(() => {
    const visible = restoreAvailableDefaultTaskProvider(
      normalizeVisibleTaskProviders(visibleTaskProviders),
      { gitlabInstalled, linearConnected },
      defaultTaskSource
    )
    return getSourceOptions().filter((option) => visible.includes(option.id))
  }, [defaultTaskSource, gitlabInstalled, linearConnected, visibleTaskProviders])
}
