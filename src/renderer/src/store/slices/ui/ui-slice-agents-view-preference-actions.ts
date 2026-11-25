import type { UISlice, UISliceSet } from './ui-slice-contract'
import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import {
  DEFAULT_AGENTS_GROUP_BY,
  DEFAULT_AGENTS_READ_FILTER,
  normalizeActivityGroupBy,
  normalizeThreadReadFilter
} from '../../../../../shared/agent-status/presentation/agents-view-thread-filters'
import { normalizeVisibleExecutionHostIds } from '../../../../../shared/execution-host/execution-host'
import { toggleCollapsedGroupSet } from './collapsed-group-toggle'

/** Persisted Agents-view presentation, with each field's absent-value default. */
export function hydrateAgentsViewPresentation(
  ui: PersistedUIState
): Pick<
  UISlice,
  | 'agentsShowChildAgents'
  | 'agentsCompactMode'
  | 'agentsShowSearch'
  | 'agentsReadFilter'
  | 'agentsGroupBy'
  | 'agentsCollapsedGroups'
> {
  return {
    agentsShowChildAgents: ui.agentsShowChildAgents === true,
    agentsCompactMode: ui.agentsCompactMode !== false,
    agentsShowSearch: ui.agentsShowSearch !== false,
    agentsReadFilter: normalizeThreadReadFilter(ui.agentsReadFilter),
    agentsGroupBy: normalizeActivityGroupBy(ui.agentsGroupBy),
    agentsCollapsedGroups: new Set(ui.agentsCollapsedGroups ?? [])
  }
}

/** Agents-view preferences; each setter persists immediately and stays separate from workspace-nav state. */
export function createAgentsViewPreferenceActions(set: UISliceSet): Partial<UISlice> {
  return {
    agentsVisibleHostIds: null,
    setAgentsVisibleHostIds: (ids) => {
      const agentsVisibleHostIds = normalizeVisibleExecutionHostIds(ids)
      set({ agentsVisibleHostIds })
      window.api.ui.set({ agentsVisibleHostIds }).catch(console.error)
    },
    agentsFilterRepoIds: [],
    setAgentsFilterRepoIds: (ids) => {
      set({ agentsFilterRepoIds: ids })
      window.api.ui.set({ agentsFilterRepoIds: [...ids] }).catch(console.error)
    },
    agentsHideWorkspacesFromOtherDevices: false,
    setAgentsHideWorkspacesFromOtherDevices: (v) => {
      set({ agentsHideWorkspacesFromOtherDevices: v })
      window.api.ui.set({ agentsHideWorkspacesFromOtherDevices: v }).catch(console.error)
    },
    agentsHideAutomationGeneratedWorkspaces: false,
    setAgentsHideAutomationGeneratedWorkspaces: (v) => {
      set({ agentsHideAutomationGeneratedWorkspaces: v })
      window.api.ui.set({ agentsHideAutomationGeneratedWorkspaces: v }).catch(console.error)
    },
    agentsHideCliCreatedWorkspaces: false,
    setAgentsHideCliCreatedWorkspaces: (v) => {
      set({ agentsHideCliCreatedWorkspaces: v })
      window.api.ui.set({ agentsHideCliCreatedWorkspaces: v }).catch(console.error)
    },
    agentsShowChildAgents: false,
    setAgentsShowChildAgents: (v) => {
      set({ agentsShowChildAgents: v })
      window.api.ui.set({ agentsShowChildAgents: v }).catch(console.error)
    },
    agentsCompactMode: true,
    setAgentsCompactMode: (v) => {
      set({ agentsCompactMode: v })
      window.api.ui.set({ agentsCompactMode: v }).catch(console.error)
    },
    agentsShowSearch: true,
    setAgentsShowSearch: (v) => {
      set({ agentsShowSearch: v })
      window.api.ui.set({ agentsShowSearch: v }).catch(console.error)
    },
    agentsReadFilter: DEFAULT_AGENTS_READ_FILTER,
    setAgentsReadFilter: (v) => {
      set({ agentsReadFilter: v })
      window.api.ui.set({ agentsReadFilter: v }).catch(console.error)
    },
    agentsGroupBy: DEFAULT_AGENTS_GROUP_BY,
    setAgentsGroupBy: (v) => {
      set({ agentsGroupBy: v })
      window.api.ui.set({ agentsGroupBy: v }).catch(console.error)
    },
    // Why: keys outlive empty groups so a folded group stays folded when it refills.
    agentsCollapsedGroups: new Set<string>(),
    toggleAgentsCollapsedGroup: (key) =>
      set((s) => {
        const next = toggleCollapsedGroupSet(s.agentsCollapsedGroups, key)
        window.api.ui.set({ agentsCollapsedGroups: [...next] }).catch(console.error)
        return { agentsCollapsedGroups: next }
      })
  }
}
