import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../../../../shared/execution-host'
import {
  cycleVisibleHostRow,
  resolveVisibleWorkspaceHostIds
} from '../../../../../../shared/workspace-view/workspace-host-visibility'
import { getSidebarHostVisibilityLabel, type SidebarHostOption } from './sidebar-host-options'

/** Publish host rows for shortcut parity; the shortcut cannot derive them without a new focus read. */
let publishedHostOptions: readonly SidebarHostOption[] = []

export function usePublishedSidebarHostOptions(hostOptions: readonly SidebarHostOption[]): void {
  useEffect(() => {
    publishedHostOptions = hostOptions
    return () => {
      publishedHostOptions = []
    }
  }, [hostOptions])
}

/** The next-host step, or undefined when there is nothing to cycle so the key passes through. */
export function resolveSidebarHostCycle(): (() => void) | undefined {
  const hostOptions = publishedHostOptions
  const store = useAppStore.getState()
  const next = cycleVisibleHostRow(
    hostOptions,
    resolveVisibleWorkspaceHostIds(store.visibleWorkspaceHostIds, store.workspaceHostScope)
  )
  if (next === undefined) {
    return undefined
  }
  return () => {
    if (next === null) {
      store.setWorkspaceHostScope(ALL_EXECUTION_HOSTS_SCOPE)
    } else {
      store.setVisibleWorkspaceHostIds(next)
    }
    store.setSidebarOpen(true)
    toast(translate('auto.components.sidebar.sidebarHostOptions.hosts', 'Hosts'), {
      id: 'sidebar-hosts-cycle',
      description: getSidebarHostVisibilityLabel(next, hostOptions)
    })
  }
}
