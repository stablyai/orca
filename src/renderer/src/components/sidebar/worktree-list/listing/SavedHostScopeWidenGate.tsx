import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../../../../shared/execution-host'
import { widenSavedExecutionHostIds } from '../../../../../../shared/execution-host/managed-orcad-execution-host'
import type { VisibleWorkspaceHostIds } from '../../../../../../shared/ui-chrome-types'
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

  useEffect(() => {
    const sidebarScope: VisibleWorkspaceHostIds =
      visibleWorkspaceHostIds ??
      (workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [workspaceHostScope])
    const widenedSidebar = widenSavedExecutionHostIds(hostOptions, sidebarScope)
    if (widenedSidebar) {
      // Row-aware scope: one merged row saves several equivalent IDs and must keep its scope (#41140).
      setVisibleWorkspaceHostIds(
        widenedSidebar,
        workspaceHostScopeForVisibleHosts(widenedSidebar, hostOptions)
      )
    } else if (sidebarScope) {
      // Hydration derives scope without row knowledge; reconcile once picker rows exist.
      const settledScope = workspaceHostScopeForVisibleHosts(sidebarScope, hostOptions)
      if (settledScope !== workspaceHostScope) {
        setVisibleWorkspaceHostIds(sidebarScope, settledScope)
      }
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
