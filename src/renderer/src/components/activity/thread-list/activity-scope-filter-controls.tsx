import React from 'react'
import { useAppStore } from '@/store'
import { DropdownMenuCheckboxItem, DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import SidebarRepositoryFilterSection from '@/components/sidebar/worktree-list/controls/SidebarRepositoryFilterSection'
import { SidebarScopeFilterMenu } from '@/components/sidebar/worktree-list/controls/SidebarScopeFilterMenu'
import { SidebarHostScopeMenuSection } from '@/components/sidebar/worktree-list/controls/SidebarHostScopeMenuSection'
import {
  getSidebarHostVisibilityLabel,
  shouldShowHostScopeControls
} from '@/components/sidebar/worktree-list/controls/sidebar-host-options'
import { useSidebarHostScopeOptions } from '@/components/sidebar/worktree-list/controls/use-sidebar-host-scope-options'
import { useAllAgentPaneThreads } from '../threads/use-agent-pane-threads'

/** Persisted Agents scope is separate from workspace navigation filters; the parent owns the Filters label/separator. */
export function ActivityScopeFilterMenuItems(): React.JSX.Element {
  const t = useTranslate()
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
        {t(
          'auto.components.activity.ActivityScopeFilterControls.hideAutomationCreated',
          'Hide automation-created'
        )}
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={hideCliCreated}
        onCheckedChange={(checked) => setHideCliCreated(checked === true)}
        onSelect={(event) => event.preventDefault()}
      >
        {t(
          'auto.components.activity.ActivityScopeFilterControls.hideCliCreated',
          'Hide CLI-created'
        )}
      </DropdownMenuCheckboxItem>
      {showOtherClientFilter ? (
        <DropdownMenuCheckboxItem
          checked={hideFromOtherDevices}
          onCheckedChange={(checked) => setHideFromOtherDevices(checked === true)}
          onSelect={(event) => event.preventDefault()}
          aria-label={t(
            'auto.components.activity.ActivityScopeFilterControls.hideOtherClientsAria',
            'Hide agents in workspaces created from other Orca clients on shared remote servers'
          )}
        >
          {t(
            'auto.components.activity.ActivityScopeFilterControls.hideOtherClients',
            'Hide other-client agents'
          )}
        </DropdownMenuCheckboxItem>
      ) : null}
      {showHostScopeControls ? (
        <SidebarHostScopeMenuSection
          hostVisibilityLabel={getSidebarHostVisibilityLabel(agentsVisibleHostIds, hostOptions, t)}
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
        // Hidden projects' agents still list here, so their projects stay filterable.
        includeHidden
      />
      <ActivityAgentFilterMenu />
      {hasScopeFilter ? (
        <DropdownMenuItem
          onSelect={() => {
            setAgentsVisibleHostIds(null)
            setAgentsFilterRepoIds([])
          }}
        >
          {t(
            'auto.components.activity.ActivityScopeFilterControls.resetScope',
            'Show all hosts and projects'
          )}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

function ActivityAgentFilterMenu(): React.JSX.Element {
  const t = useTranslate()
  const agentTypes = useAppStore((s) => s.agentsFilterAgentTypes)
  const setAgentTypes = useAppStore((s) => s.setAgentsFilterAgentTypes)
  const { allThreads } = useAllAgentPaneThreads()
  const availableTypes = new Set<string>(agentTypes)
  for (const thread of allThreads) {
    availableTypes.add(thread.agentType)
  }
  const activityAgents = getAgentCatalog().filter((agent) => availableTypes.has(agent.id))
  const allAgentsLabel = t('auto.components.skills.filter.allAgents', 'All agents')
  const visibilityLabel =
    agentTypes.length === 0
      ? allAgentsLabel
      : agentTypes.length === 1
        ? getAgentLabel(agentTypes[0])
        : t('sidebar.agentSummary.agentCount', '{{count}} agents', {
            count: agentTypes.length,
            defaultValue_one: '{{count}} agent'
          })

  return (
    <SidebarScopeFilterMenu
      title={t('auto.components.activity.ActivityScopeFilterControls.agents', 'Agents')}
      visibilityLabel={visibilityLabel}
      options={activityAgents}
      selectedIds={agentTypes}
      onChange={setAgentTypes}
      placeholders={{
        filter: t(
          'auto.components.activity.ActivityScopeFilterControls.filterAgents',
          'Filter agents...'
        ),
        add: t('auto.components.activity.ActivityScopeFilterControls.addAgent', 'Add agent...')
      }}
      emptyMessages={{
        unfiltered: t(
          'auto.components.activity.ActivityScopeFilterControls.noAgentsMatch',
          'No agents match'
        ),
        filtered: t(
          'auto.components.activity.ActivityScopeFilterControls.noUnselectedAgentsMatch',
          'No unselected agents match'
        )
      }}
      getLabel={(agent) => agent.label}
      renderOption={({ id, label }) => (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <AgentIcon agent={id} size={13} />
          <span className="truncate">{label}</span>
        </span>
      )}
    />
  )
}

/** Count persisted filters, including stale repo IDs, so hidden agents stay discoverable and resettable. */
export function useActivityScopeFilterCount(): number {
  return useAppStore(
    (state) =>
      (state.agentsVisibleHostIds !== null ? 1 : 0) +
      state.agentsFilterRepoIds.length +
      state.agentsFilterAgentTypes.length +
      (state.agentsHideWorkspacesFromOtherDevices ? 1 : 0) +
      (state.agentsHideAutomationGeneratedWorkspaces ? 1 : 0) +
      (state.agentsHideCliCreatedWorkspaces ? 1 : 0)
  )
}
