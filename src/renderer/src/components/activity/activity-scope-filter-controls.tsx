import React from 'react'
import { useAppStore } from '@/store'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import SidebarRepositoryFilterSection from '@/components/sidebar/SidebarRepositoryFilterSection'
import { SidebarHostScopeMenuSection } from '@/components/sidebar/SidebarHostScopeMenuSection'
import {
  getSidebarHostVisibilityLabel,
  shouldShowHostScopeControls
} from '@/components/sidebar/sidebar-host-options'
import { useSidebarHostScopeOptions } from '@/components/sidebar/use-sidebar-host-scope-options'

/**
 * Whether {@link ActivityScopeFilterMenuItems} renders anything.
 * Why exported: the parent owns the Filters label and separator, so it has to
 * know whether the section would be empty.
 */
export function useActivityScopeFilterMenuItemsVisible(): boolean {
  const repos = useAppStore((s) => s.repos)
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  const { hostOptions } = useSidebarHostScopeOptions()
  return (
    agentsVisibleHostIds !== null ||
    agentsFilterRepoIds.length > 0 ||
    shouldShowHostScopeControls(hostOptions) ||
    repos.length > 1
  )
}

/**
 * Host/project scope items for the Agents activity surfaces. State is the
 * persisted agents-view scope (agentsVisibleHostIds / agentsFilterRepoIds),
 * deliberately separate from the workspace-nav filters. The parent owns the
 * Filters label and separator.
 */
export function ActivityScopeFilterMenuItems(): React.JSX.Element | null {
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const setAgentsVisibleHostIds = useAppStore((s) => s.setAgentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  const setAgentsFilterRepoIds = useAppStore((s) => s.setAgentsFilterRepoIds)
  const { hostOptions } = useSidebarHostScopeOptions()
  const showHostScopeControls = shouldShowHostScopeControls(hostOptions)
  const hasScopeFilter = agentsVisibleHostIds !== null || agentsFilterRepoIds.length > 0
  const visible = useActivityScopeFilterMenuItemsVisible()

  if (!visible) {
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
      {hasScopeFilter ? (
        <DropdownMenuItem
          onSelect={() => {
            setAgentsVisibleHostIds(null)
            setAgentsFilterRepoIds([])
          }}
        >
          {translate(
            'auto.components.activity.ActivityScopeFilterControls.resetScope',
            'Show all hosts and projects'
          )}
        </DropdownMenuItem>
      ) : null}
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
