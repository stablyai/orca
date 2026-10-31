import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import type { HostAuthority } from '../../../shared/host-authority'
import { findFolderWorkspaceOwner } from './folder-workspace-runtime-owner'
import { resolveOwner } from './resolve-owner'
import { captureDirectSshMutationExpectation } from './ssh-mutation-expectation'
import {
  assertWorktreeOperationGenerationSnapshotCurrent,
  captureWorktreeOperationGenerationSnapshot,
  type WorktreeOperationGenerationSnapshot
} from './worktree-operation-generation'
import {
  getFloatingWorkspaceOperationRoute,
  resolveWorktreeOperationRoute,
  type WorktreeOperationRoute,
  type WorktreeOperationRouteResolution,
  type WorktreeOperationRouteState
} from './worktree-operation-route'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'
import {
  resolveQualifiedIndexedFolderWorkspace,
  selectFolderWorkspaces,
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

export type EditorFileOperationProvenance = {
  generation: WorktreeOperationGenerationSnapshot
  ownershipProjection: 'explicit' | 'legacy'
  childRepo?: { id: string; path: string }
  expectedSshConnectionGeneration?: number
}

type EditorOwnerState = Pick<
  AppState,
  | 'settings'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'runtimeEnvironments'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'removedRuntimeEnvironmentIds'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
>

export const OWNER_CHANGED_MESSAGE =
  "Couldn't verify which host owns this file. Reopen the file after the connection settles."

export function captureEditorFileOperationProvenance(
  state: EditorOwnerState,
  worktreeId: string,
  ownerHint: string | null | undefined,
  ownerHintProvided: boolean
): EditorFileOperationProvenance {
  const owner = resolveEditorOwnerRoute(
    state,
    worktreeId,
    state.activeWorktreeId === worktreeId ? state.activeWorkspaceExecutionHostId : null
  )
  const ownershipProjection = owner.ownershipProjection
  const hintedRuntimeEnvironmentId = ownerHint?.trim() || null
  const route =
    owner.kind === 'ambiguous'
      ? null
      : ownershipProjection === 'legacy' &&
          ownerHintProvided &&
          isWorktreePublished(state, worktreeId)
        ? {
            executionHostId: hintedRuntimeEnvironmentId
              ? (`runtime:${encodeURIComponent(hintedRuntimeEnvironmentId)}` as const)
              : ('local' as const),
            runtimeEnvironmentId: hintedRuntimeEnvironmentId
          }
        : owner.kind === 'resolved'
          ? owner.route
          : null
  if (!route || (ownerHintProvided && (ownerHint?.trim() || null) !== route.runtimeEnvironmentId)) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  const authority = resolveEditorOperationAuthority(state, worktreeId, route)
  const expectedSshConnectionGeneration = getExpectedSshConnectionGeneration(
    state,
    route,
    authority
  )
  return {
    generation: captureWorktreeOperationGenerationSnapshot(route, authority),
    ownershipProjection,
    ...(expectedSshConnectionGeneration === undefined ? {} : { expectedSshConnectionGeneration })
  }
}

function resolveEditorOperationAuthority(
  state: EditorOwnerState,
  worktreeId: string,
  route: WorktreeOperationRoute
): HostAuthority | undefined {
  if (!route.executionHostId) {
    return undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const folder = resolveQualifiedIndexedFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      route.executionHostId
    )
    if (folder.kind !== 'selected' || !folder.value.workspace.folderPath) {
      return undefined
    }
  } else if (worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
    const explicit = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
    if (explicit.kind !== 'resolved' || JSON.stringify(explicit.route) !== JSON.stringify(route)) {
      return undefined
    }
  }
  const match = resolveOwner(focusFreeRouteStateOf(state), {
    workspaceId: worktreeId,
    ...(route.executionHostId ? { hostId: route.executionHostId } : {})
  })
  if (match.kind !== 'resolved') {
    return undefined
  }
  const environmentId =
    match.owner.endpoint.kind === 'environment' ? match.owner.endpoint.environmentId : null
  return environmentId === route.runtimeEnvironmentId ? match.owner : undefined
}

export function resolveEditorOwnerRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  folderHostId?: ExecutionHostId | null
): WorktreeOperationRouteResolution & {
  ownershipProjection: EditorFileOperationProvenance['ownershipProjection']
} {
  const floatingRoute = getFloatingWorkspaceOperationRoute(worktreeId)
  if (floatingRoute) {
    return { kind: 'resolved', route: floatingRoute, ownershipProjection: 'explicit' }
  }
  const ownerState = focusFreeRouteStateOf(state)
  const scope = parseWorkspaceKey(worktreeId)
  const explicit: WorktreeOperationRouteResolution =
    scope?.type === 'folder'
      ? { kind: 'missing' }
      : resolveExplicitWorktreeOperationRouteResult(ownerState, worktreeId)
  if (explicit.kind !== 'missing') {
    return { ...explicit, ownershipProjection: 'explicit' }
  }
  let route = resolveWorktreeOperationRoute(ownerState, worktreeId)
  if (!route && scope?.type === 'folder' && folderHostId) {
    // Same-id folders may use a host qualifier only when the catalog confirms that owner.
    const folder = findFolderWorkspaceOwner(ownerState, scope.folderWorkspaceId, folderHostId)
    const qualifiedRoute = folder
      ? resolveWorktreeOperationRoute({ ...ownerState, folderWorkspaces: [folder] }, worktreeId)
      : null
    route = qualifiedRoute?.executionHostId === folderHostId ? qualifiedRoute : null
  }
  return route
    ? { kind: 'resolved', route, ownershipProjection: 'legacy' }
    : { kind: 'missing', ownershipProjection: 'legacy' }
}

// Every key listed, so a new route input cannot be silently dropped from the projection.
type AllRouteStateKeys = {
  [K in keyof Required<WorktreeOperationRouteState>]: WorktreeOperationRouteState[K]
}
const focusFreeRouteStates = new WeakMap<WorktreeOperationRouteState, WorktreeOperationRouteState>()

/** Neither workspace focus nor the Active Server focus can replace a file's catalog owner. Projects only route inputs: spreading the full app state per lookup dominated ownership sweeps. */
function focusFreeRouteStateOf(state: WorktreeOperationRouteState): WorktreeOperationRouteState {
  let projected = focusFreeRouteStates.get(state)
  if (!projected) {
    const routeState: AllRouteStateKeys = {
      settings: state.settings,
      runtimeEnvironments: state.runtimeEnvironments,
      folderWorkspaces: selectFolderWorkspaces(state),
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      repos: state.repos,
      worktreesByRepo: selectWorktreesByRepo(state),
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
      runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null
    }
    projected = routeState
    focusFreeRouteStates.set(state, projected)
  }
  return projected
}

export function assertEditorFileOperationCurrent(
  state: EditorOwnerState,
  worktreeId: string,
  provenance: EditorFileOperationProvenance
): WorktreeOperationRoute {
  const route = assertWorktreeOperationGenerationSnapshotCurrent(
    () => state,
    worktreeId,
    provenance.generation,
    () => new Error(OWNER_CHANGED_MESSAGE),
    () => resolveCurrentEditorRoute(state, worktreeId, provenance),
    () => resolveEditorOperationAuthority(state, worktreeId, provenance.generation.route)
  )
  const currentGeneration = getExpectedSshConnectionGeneration(
    state,
    route,
    provenance.generation.authority
  )
  if (currentGeneration !== provenance.expectedSshConnectionGeneration) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  return route
}

function resolveCurrentEditorRoute(
  state: EditorOwnerState,
  worktreeId: string,
  provenance: EditorFileOperationProvenance
): WorktreeOperationRoute | null {
  const owner = resolveEditorOwnerRoute(
    state,
    worktreeId,
    provenance.generation.route.executionHostId
  )
  if (owner.ownershipProjection === 'explicit' && owner.kind === 'resolved') {
    return owner.route
  }
  if (owner.kind === 'ambiguous' || provenance.ownershipProjection === 'explicit') {
    return null
  }
  // Folder workspaces must still confirm their live owner rather than retain a published-worktree hint.
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return owner.kind === 'resolved' ? owner.route : null
  }
  return isWorktreePublished(state, worktreeId) ? provenance.generation.route : null
}

function isWorktreePublished(state: EditorOwnerState, worktreeId: string): boolean {
  return (
    Object.values(selectWorktreesByRepo(state) ?? {}).some((worktrees) =>
      worktrees.some((worktree) => worktree.id === worktreeId)
    ) ||
    Object.values(selectDetectedWorktreesByRepo(state) ?? {}).some((result) =>
      result.worktrees.some((worktree) => worktree.id === worktreeId)
    )
  )
}

export function getExpectedSshConnectionGeneration(
  state: Pick<AppState, 'sshConnectionStates' | 'sshStateByEnvironment'>,
  route: WorktreeOperationRoute,
  authority?: HostAuthority
): number | undefined {
  const host = parseExecutionHostId(authority?.at ?? route.executionHostId)
  if (host?.kind !== 'ssh') {
    return undefined
  }
  try {
    return captureDirectSshMutationExpectation(state, host.targetId, route.runtimeEnvironmentId)
      .expectedSshConnectionGeneration
  } catch {
    return undefined
  }
}
