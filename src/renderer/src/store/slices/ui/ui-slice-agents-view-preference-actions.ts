import type { UISlice, UISliceSet } from './ui-slice-contract'
import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import {
  DEFAULT_AGENTS_GROUP_BY,
  DEFAULT_AGENTS_READ_FILTER,
  normalizeActivityAgentTypes,
  normalizeActivityGroupBy,
  normalizeThreadReadFilter
} from '../../../../../shared/agent-status/presentation/agents-view-thread-filters'
import { normalizeVisibleExecutionHostIds } from '../../../../../shared/execution-host/execution-host'
import {
  preserveStringArrayIdentity,
  sanitizePersistedRepoIds
} from './ui-slice-hydration-sanitizers'

export function hydrateAgentsViewPreferences(
  current: UISlice,
  ui: PersistedUIState,
  validRepoIds: ReadonlySet<string>
) {
  const repoIds = sanitizePersistedRepoIds(ui.agentsFilterRepoIds)
  return {
    agentsVisibleHostIds: preserveStringArrayIdentity(
      current.agentsVisibleHostIds,
      normalizeVisibleExecutionHostIds(ui.agentsVisibleHostIds)
    ),
    agentsFilterRepoIds: preserveStringArrayIdentity(
      current.agentsFilterRepoIds,
      validRepoIds.size === 0 ? repoIds : repoIds.filter((repoId) => validRepoIds.has(repoId))
    ),
    agentsFilterAgentTypes:
      preserveStringArrayIdentity(
        current.agentsFilterAgentTypes,
        normalizeActivityAgentTypes(ui.agentsFilterAgentTypes)
      ) ?? [],
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
    agentsFilterAgentTypes: [],
    setAgentsFilterAgentTypes: (types) => {
      const agentsFilterAgentTypes = normalizeActivityAgentTypes(types)
      set({ agentsFilterAgentTypes })
      window.api.ui.set({ agentsFilterAgentTypes }).catch(console.error)
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
    }
  }
}
