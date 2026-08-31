import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { findIndexedProjectGroupOwner } from '@/lib/worktree-runtime-owner-index'

type ProjectGroupHostParts = Pick<ProjectGroup, 'connectionId' | 'executionHostId'>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>
type RoutingSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

type ProjectGroupOwnerRoutingState = {
  projectGroups: readonly ProjectGroupOwnerRecord[]
  settings: RoutingSettings
}

// Why: persisted rows predate host stamping and may carry padded/unparseable ids; normalize so
// routing and catalog identity agree on the same owner host.
export function getProjectGroupHostId(group: ProjectGroupHostParts): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(group.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  const connectionId = group.connectionId?.trim()
  return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
}

export function catalogOwnsHost(catalogHostId: string, rowHostId: string): boolean {
  if (catalogHostId !== LOCAL_EXECUTION_HOST_ID) {
    return catalogHostId === rowHostId
  }
  return parseExecutionHostId(rowHostId)?.kind !== 'runtime'
}

export function projectGroupMatchesOwnerHost(
  group: ProjectGroupOwnerRecord,
  groupId: string,
  ownerHostId: ExecutionHostId | null
): boolean {
  if (group.id !== groupId) {
    return false
  }
  return ownerHostId ? catalogOwnsHost(ownerHostId, getProjectGroupHostId(group)) : true
}

export function resolveProjectGroupOwnerHostId(
  state: ProjectGroupOwnerRoutingState,
  groupId: string,
  hostId?: ExecutionHostId
): ExecutionHostId | null {
  const owner = findIndexedProjectGroupOwner(state.projectGroups, groupId, hostId)
  if (!owner) {
    return null
  }
  if (hostId) {
    return hostId
  }
  // Why: an unstamped row carries no owner, so keep the focused-host behavior instead of assuming local.
  if (!owner.executionHostId && !owner.connectionId) {
    return null
  }
  return getProjectGroupHostId(owner)
}

// Why: the sidebar lists groups from every host, so mutations must route to the row's owner
// instead of whichever host currently has focus. Mirrors settingsForRepoOwner.
export function settingsForProjectGroupOwner(
  state: ProjectGroupOwnerRoutingState,
  groupId: string,
  hostId?: ExecutionHostId
): RoutingSettings {
  const ownerHostId = resolveProjectGroupOwnerHostId(state, groupId, hostId)
  if (!ownerHostId) {
    return state.settings
  }
  const parsed = parseExecutionHostId(ownerHostId)
  if (parsed?.kind === 'runtime') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : { activeRuntimeEnvironmentId: parsed.environmentId }
  }
  // Why: direct-SSH groups live in the local main process catalog, so they route through window.api.
  if (
    (parsed?.kind === 'local' || parsed?.kind === 'ssh') &&
    state.settings?.activeRuntimeEnvironmentId
  ) {
    return { ...state.settings, activeRuntimeEnvironmentId: null }
  }
  return state.settings
}
