import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { ALL_EXECUTION_HOSTS_SCOPE, type ExecutionHostId } from '../../../../shared/execution-host'
import { widenSavedExecutionHostIds } from '../../../../shared/managed-orcad-execution-host'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'

/**
 * Widens the saved sidebar and agents host scopes to both ids of a merged SSH host, so the exact-id
 * filters behind a checked merged row match either owner.
 */
export function SavedHostScopeWidenGate(): null {
  const { hostOptions } = useSidebarHostScopeOptions()
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)
  const setAgentsVisibleHostIds = useAppStore((s) => s.setAgentsVisibleHostIds)

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
