import type { AppState } from '@/store/types'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import type { AgentLaunchRouteStore } from './agent-launch-route-input'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

const AGENT_LAUNCH_ROUTE_STATE_KEYS = [
  'settings',
  'worktreesByRepo',
  'folderWorkspaces',
  'repos',
  'detectedWorktreesByRepo',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds',
  'activeRepoId',
  'projects'
] as const satisfies readonly (keyof AgentLaunchRouteStore & keyof AppState)[]
type AgentLaunchRouteStateKey = (typeof AGENT_LAUNCH_ROUTE_STATE_KEYS)[number]
type AgentLaunchRouteKey = AgentLaunchRouteStateKey | 'hostStatuses'
// Completeness, not just membership: a reader input missing from the list fails to compile.
type AssertNoMissingRouteKey<T extends never> = T
export type AgentLaunchRouteKeysAreComplete = AssertNoMissingRouteKey<
  Exclude<keyof AgentLaunchRouteStore, AgentLaunchRouteKey>
>
export type AgentLaunchRouteView = { [K in AgentLaunchRouteStateKey]: AppState[K] } & {
  hostStatuses: RuntimeStatuses
}

const agentLaunchRouteInputsChanged = (
  state: AppState,
  statuses: RuntimeStatuses,
  previous: AgentLaunchRouteView
): boolean => statuses !== previous.hostStatuses || routeStateKeysChanged(state, previous)

function routeStateKeysChanged(state: AppState, previous: AgentLaunchRouteView): boolean {
  for (const key of AGENT_LAUNCH_ROUTE_STATE_KEYS) {
    if (state[key] !== previous[key]) {
      return true
    }
  }
  return false
}

/** A fresh route view, for render-time readers whose statuses may be a retained view's frozen map. */
export function buildAgentLaunchRouteView(
  state: AppState,
  statuses: RuntimeStatuses
): AgentLaunchRouteView {
  return {
    settings: state.settings,
    hostStatuses: statuses,
    worktreesByRepo: selectWorktreesByRepo(state),
    folderWorkspaces: selectFolderWorkspaces(state),
    repos: state.repos,
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
    activeRepoId: state.activeRepoId,
    projects: state.projects
  }
}

let lastRouteView: AgentLaunchRouteView | undefined
/** The live selectors' shared view, kept while its inputs are unchanged. */
export function selectAgentLaunchRouteView(
  state: AppState,
  statuses: RuntimeStatuses
): AgentLaunchRouteView {
  if (!lastRouteView || agentLaunchRouteInputsChanged(state, statuses, lastRouteView)) {
    lastRouteView = buildAgentLaunchRouteView(state, statuses)
  }
  return lastRouteView
}
