import React from 'react'
import { useAppStore } from '@/store'
import { DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import SidebarRepositoryFilterSection from '@/components/sidebar/SidebarRepositoryFilterSection'
import { SidebarHostScopeMenuSection } from '@/components/sidebar/SidebarHostScopeMenuSection'
import {
  getSidebarHostVisibilityLabel,
  shouldShowHostScopeControls
} from '@/components/sidebar/sidebar-host-options'
import { useSidebarHostScopeOptions } from '@/components/sidebar/use-sidebar-host-scope-options'

/**
 * Host/project scope controls for the Agents activity surfaces. State is the
 * persisted agents-view scope (agentsVisibleHostIds / agentsFilterRepoIds),
 * deliberately separate from the workspace-nav filters.
 */
export function ActivityScopeFilterMenuSections(): React.JSX.Element | null {
  const repos = useAppStore((s) => s.repos)
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const setAgentsVisibleHostIds = useAppStore((s) => s.setAgentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  const setAgentsFilterRepoIds = useAppStore((s) => s.setAgentsFilterRepoIds)
  const { hostOptions } = useSidebarHostScopeOptions()
  const showHostScopeControls = shouldShowHostScopeControls(hostOptions)

  if (!showHostScopeControls && repos.length <= 1) {
    return null
  }
  return (
    <>
      {showHostScopeControls ? (
        <SidebarHostScopeMenuSection
          hostVisibilityLabel={getSidebarHostVisibilityLabel(agentsVisibleHostIds, hostOptions)}
          hostOptions={hostOptions}
          preserveWorkspaceBoardOpen={false}
          // Why: the section only calls this to reset to "all hosts".
          setWorkspaceHostScope={() => setAgentsVisibleHostIds(null)}
          visibleWorkspaceHostIds={agentsVisibleHostIds}
          setVisibleWorkspaceHostIds={setAgentsVisibleHostIds}
        />
      ) : null}
      <SidebarRepositoryFilterSection
        filterRepoIds={agentsFilterRepoIds}
        setFilterRepoIds={setAgentsFilterRepoIds}
      />
      <DropdownMenuSeparator />
    </>
  )
}

/**
 * Whether the persisted agents-view scope narrows the list.
 * Why exported: the options-menu trigger shows a dot for an active scope, so a
 * filter that survives restarts can't silently hide running agents.
 */
export function useActivityScopeFilterActive(): boolean {
  return useAppStore(
    (state) => state.agentsVisibleHostIds !== null || state.agentsFilterRepoIds.length > 0
  )
}
