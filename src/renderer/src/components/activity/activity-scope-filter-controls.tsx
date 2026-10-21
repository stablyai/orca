import React from 'react'
import { useAppStore } from '@/store'
import { DropdownMenuCheckboxItem, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import SidebarRepositoryFilterSection from '@/components/sidebar/SidebarRepositoryFilterSection'
import { SidebarHostScopeMenuSection } from '@/components/sidebar/SidebarHostScopeMenuSection'
import {
  getSidebarHostVisibilityLabel,
  shouldShowHostScopeControls
} from '@/components/sidebar/sidebar-host-options'
import { useSidebarHostScopeOptions } from '@/components/sidebar/use-sidebar-host-scope-options'

/**
 * Workspace-origin, host, and project scope items for the Agents activity surfaces. State is the
 * persisted agents-view scope (agentsHide*, agentsVisibleHostIds, agentsFilterRepoIds),
 * deliberately separate from the workspace-nav filters. The parent owns the Filters label and
 * separator.
 */
export function ActivityScopeFilterMenuItems(): React.JSX.Element {
  const agentsVisibleHostIds = useAppStore((s) => s.agentsVisibleHostIds)
  const setAgentsVisibleHostIds = useAppStore((s) => s.setAgentsVisibleHostIds)
  const agentsFilterRepoIds = useAppStore((s) => s.agentsFilterRepoIds)
  const setAgentsFilterRepoIds = useAppStore((s) => s.setAgentsFilterRepoIds)
  const hideAutomationGenerated = useAppStore((s) => s.agentsHideAutomationGeneratedWorkspaces)
  const setHideAutomationGenerated = useAppStore(
    (s) => s.setAgentsHideAutomationGeneratedWorkspaces
  )
  const hideCliCreated = useAppStore((s) => s.agentsHideCliCreatedWorkspaces)
  const setHideCliCreated = useAppStore((s) => s.setAgentsHideCliCreatedWorkspaces)
  const hideFromOtherDevices = useAppStore((s) => s.agentsHideWorkspacesFromOtherDevices)
  const setHideFromOtherDevices = useAppStore((s) => s.setAgentsHideWorkspacesFromOtherDevices)
  // Same gate as the workspace menu: other-client provenance only exists with paired runtimes.
  const showOtherClientFilter = useAppStore(
    (s) =>
      !s.runtimeEnvironmentCatalogHydrated ||
      s.runtimeEnvironments.length > 0 ||
      s.agentsHideWorkspacesFromOtherDevices
  )
  const { hostOptions } = useSidebarHostScopeOptions()
  const showHostScopeControls = shouldShowHostScopeControls(hostOptions)
  const hasScopeFilter = agentsVisibleHostIds !== null || agentsFilterRepoIds.length > 0

  return (
    <>
      <DropdownMenuCheckboxItem
        checked={hideAutomationGenerated}
        onCheckedChange={(checked) => setHideAutomationGenerated(checked === true)}
        onSelect={(event) => event.preventDefault()}
      >
        {translate(
          'auto.components.activity.ActivityScopeFilterControls.hideAutomationCreated',
          'Hide automation-created'
        )}
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={hideCliCreated}
        onCheckedChange={(checked) => setHideCliCreated(checked === true)}
        onSelect={(event) => event.preventDefault()}
      >
        {translate(
          'auto.components.activity.ActivityScopeFilterControls.hideCliCreated',
          'Hide CLI-created'
        )}
      </DropdownMenuCheckboxItem>
      {showOtherClientFilter ? (
        <DropdownMenuCheckboxItem
          checked={hideFromOtherDevices}
          onCheckedChange={(checked) => setHideFromOtherDevices(checked === true)}
          onSelect={(event) => event.preventDefault()}
          aria-label={translate(
            'auto.components.activity.ActivityScopeFilterControls.hideOtherClientsAria',
            'Hide agents in workspaces created from other Orca clients on shared remote servers'
          )}
        >
          {translate(
            'auto.components.activity.ActivityScopeFilterControls.hideOtherClients',
            'Hide other-client agents'
          )}
        </DropdownMenuCheckboxItem>
      ) : null}
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

/** Active persisted agents-view filters, for the options trigger badge; a filter that survives
 *  restarts must not silently hide running agents. Stale repo ids count so they stay resettable. */
export function useActivityScopeFilterCount(): number {
  return useAppStore(
    (state) =>
      (state.agentsVisibleHostIds !== null ? 1 : 0) +
      state.agentsFilterRepoIds.length +
      (state.agentsHideWorkspacesFromOtherDevices ? 1 : 0) +
      (state.agentsHideAutomationGeneratedWorkspaces ? 1 : 0) +
      (state.agentsHideCliCreatedWorkspaces ? 1 : 0)
  )
}
