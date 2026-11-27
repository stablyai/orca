import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import type { AppState } from '../../types'
import type { ManualRepoOrderEntry } from '../../../../../shared/ui-chrome/ui-chrome-types'
import {
  normalizeExecutionHostScope,
  normalizeExecutionHostOrder,
  normalizeVisibleExecutionHostIds
} from '../../../../../shared/execution-host/execution-host'
import { DEFAULT_HIDE_SLEEPING_WORKSPACES } from '../../../../../shared/workspace-view/sleeping-workspace-visibility'
import { parsePersistedAutomationHostFilter } from '../../../../../shared/automations/ownership/automation-host-filter'
import {
  normalizeActivityGroupBy,
  normalizeThreadReadFilter
} from '../../../../../shared/agent-status/presentation/agents-view-thread-filters'
import { preserveStringArrayIdentity } from './ui-slice-hydration-array-identity'
import {
  normalizeHydratedVisibleWorkspaceHostIds,
  sanitizePerWorktreePreferences
} from './ui-slice-hydration-sanitizers'

export function hydrateWorkspaceFilters(
  ui: PersistedUIState,
  s: Pick<AppState, 'agentsVisibleHostIds' | 'agentsFilterRepoIds'>,
  validRepoIds: ReadonlySet<string>,
  {
    persistedFilterRepoIds,
    persistedAgentsFilterRepoIds
  }: {
    persistedFilterRepoIds: string[]
    persistedAgentsFilterRepoIds: string[]
  },
  manualRepoOrder: ManualRepoOrderEntry[],
  orderedRepos: AppState['repos']
) {
  return {
    // Why: ignore older positive-form keys so old profiles start from the new default (sleeping workspaces visible).
    showSleepingWorkspaces: !(ui.hideSleepingWorkspaces ?? DEFAULT_HIDE_SLEEPING_WORKSPACES),
    workspaceHostScope: normalizeExecutionHostScope(ui.workspaceHostScope),
    visibleWorkspaceHostIds: normalizeHydratedVisibleWorkspaceHostIds(ui),
    workspaceHostOrder: normalizeExecutionHostOrder(ui.workspaceHostOrder),
    // Why: a malformed or legacy filter value must degrade to All hosts, never throw during hydration.
    automationHostFilter: parsePersistedAutomationHostFilter(ui.automationHostFilter),
    manualRepoOrder,
    // Why: apply the desktop-owned overlay immediately since UI state can arrive after a catalog or from another client.
    repos: orderedRepos,
    hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace ?? false,
    hideAutomationGeneratedWorkspaces: ui.hideAutomationGeneratedWorkspaces === true,
    hideCliCreatedWorkspaces: ui.hideCliCreatedWorkspaces === true,
    hideDetachedHeadWorkspaces: ui.hideDetachedHeadWorkspaces === true,
    hideWorkspacesFromOtherDevices: ui.hideWorkspacesFromOtherDevices === true,
    // Why !== false: profiles written before #8873 have no key, and they are
    // precisely the ones showing the bug, so absence must mean "exempt".
    alwaysShowDefaultBranchWorkspace: ui.alwaysShowDefaultBranchWorkspace !== false,
    ...sanitizePerWorktreePreferences(ui),
    gitGraphFiltersByWorktree: ui.gitGraphFiltersByWorktree ?? {},
    // Why: startup hydrates UI before repo catalogs, so defer repo-filter validation to the all-host refresh.
    filterRepoIds:
      validRepoIds.size === 0
        ? persistedFilterRepoIds
        : persistedFilterRepoIds.filter((repoId) => validRepoIds.has(repoId)),
    agentsVisibleHostIds: preserveStringArrayIdentity(
      s.agentsVisibleHostIds,
      normalizeVisibleExecutionHostIds(ui.agentsVisibleHostIds)
    ),
    agentsFilterRepoIds: preserveStringArrayIdentity(
      s.agentsFilterRepoIds,
      validRepoIds.size === 0
        ? persistedAgentsFilterRepoIds
        : persistedAgentsFilterRepoIds.filter((repoId) => validRepoIds.has(repoId))
    ),
    agentsHideWorkspacesFromOtherDevices: ui.agentsHideWorkspacesFromOtherDevices === true,
    agentsHideAutomationGeneratedWorkspaces: ui.agentsHideAutomationGeneratedWorkspaces === true,
    agentsHideCliCreatedWorkspaces: ui.agentsHideCliCreatedWorkspaces === true,
    agentsShowChildAgents: ui.agentsShowChildAgents === true,
    agentsCompactMode: ui.agentsCompactMode !== false,
    agentsShowSearch: ui.agentsShowSearch !== false,
    agentsReadFilter: normalizeThreadReadFilter(ui.agentsReadFilter),
    agentsGroupBy: normalizeActivityGroupBy(ui.agentsGroupBy)
  }
}
