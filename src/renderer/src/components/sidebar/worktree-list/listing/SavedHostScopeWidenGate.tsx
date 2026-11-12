import { useEffect } from 'react'
import { useAppStore } from '@/store'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { widenSavedExecutionHostIds } from '../../../../../../shared/execution-host/managed-orcad-execution-host'
import { workspaceHostScopeForVisibleHosts } from '../../../../../../shared/workspace-view/workspace-host-visibility'
import { useSidebarHostScopeOptions } from '../controls/use-sidebar-host-scope-options'

/** Merged SSH rows represent two owner IDs; widen saved filters so selecting the row includes both. */
export function SavedHostScopeWidenGate(): null {
  const { hostOptions } = useSidebarHostScopeOptions()
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)
  const setAgentsVisibleHostIds = useAppStore((s) => s.setAgentsVisibleHostIds)
  const setWorkspaceHostScope = useAppStore((s) => s.setWorkspaceHostScope)

  useEffect(() => {
    const sidebarScope: readonly ExecutionHostId[] | null =
      visibleWorkspaceHostIds ??
      (workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [workspaceHostScope])
    const widenedSidebar = widenSavedExecutionHostIds(hostOptions, sidebarScope)
    if (widenedSidebar) {
      setVisibleWorkspaceHostIds(widenedSidebar)
      // Widening one merged row must not read as several hosts and clear its scope (#41140).
      setWorkspaceHostScope(workspaceHostScopeForVisibleHosts(widenedSidebar, hostOptions))
    }
    const widenedAgents = widenSavedExecutionHostIds(hostOptions, agentsVisibleHostIds)
    if (widenedAgents) {
      setAgentsVisibleHostIds(widenedAgents)
    }
  }, [
    agentsVisibleHostIds,
    hostOptions,
    setAgentsVisibleHostIds,
    setWorkspaceHostScope,
    setVisibleWorkspaceHostIds,
    visibleWorkspaceHostIds,
    workspaceHostScope
  ])
  return null
}
