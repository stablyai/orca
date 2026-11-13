import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { widenSavedExecutionHostIds } from '../../../../../../shared/execution-host/managed-orcad-execution-host'
import { useSidebarHostScopeOptions } from '../controls/use-sidebar-host-scope-options'
import { usePublishedSidebarHostOptions } from '../controls/sidebar-host-cycle'

/** Merged SSH rows represent two owner IDs; widen saved filters so selecting the row includes both. */
export function SavedHostScopeWidenGate(): null {
  const { hostOptions } = useSidebarHostScopeOptions()
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)
  const setAgentsVisibleHostIds = useAppStore((s) => s.setAgentsVisibleHostIds)
  usePublishedSidebarHostOptions(hostOptions)

  useEffect(() => {
    const sidebarScope: readonly ExecutionHostId[] | null =
      visibleWorkspaceHostIds ??
      (workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [workspaceHostScope])
    const widenedSidebar = widenSavedExecutionHostIds(hostOptions, sidebarScope)
    if (widenedSidebar) {
      setVisibleWorkspaceHostIds(widenedSidebar)
    }
    const widenedAgents = widenSavedExecutionHostIds(hostOptions, agentsVisibleHostIds)
    if (widenedAgents) {
      setAgentsVisibleHostIds(widenedAgents)
    }
  }, [
    agentsVisibleHostIds,
    hostOptions,
    setAgentsVisibleHostIds,
    setVisibleWorkspaceHostIds,
    visibleWorkspaceHostIds,
    workspaceHostScope
  ])
  return null
}
