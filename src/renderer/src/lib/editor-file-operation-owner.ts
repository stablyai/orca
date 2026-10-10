import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import {
  runtimeTargetForOwnerEnvironment,
  type RuntimeClientTarget
} from '@/runtime/runtime-client-target'
import { findFolderWorkspaceOwner } from './folder-workspace-runtime-owner'
import {
  assertWorktreeOperationGenerationSnapshotCurrent,
  captureWorktreeOperationGenerationSnapshot,
  type WorktreeOperationGenerationSnapshot
} from './worktree-operation-generation'
import {
  getFloatingWorkspaceOperationRoute,
  resolveExplicitWorktreeOperationRouteResult,
  resolveWorktreeOperationRoute,
  type WorktreeOperationRoute
} from './worktree-operation-route'

export type EditorFileOperationProvenance = {
  generation: WorktreeOperationGenerationSnapshot
  ownershipProjection: 'explicit' | 'legacy'
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

const OWNER_CHANGED_MESSAGE =
  "Couldn't verify which host owns this file. Reopen the file after the connection settles."

export function captureEditorFileOperationProvenance(
  state: EditorOwnerState,
  worktreeId: string,
  ownerHint: string | null | undefined,
  ownerHintProvided: boolean
): EditorFileOperationProvenance {
  const explicitResolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  const worktreeIsPublished = isWorktreePublished(state, worktreeId)
  const ownershipProjection =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID || explicitResolution.kind === 'resolved'
      ? 'explicit'
      : 'legacy'
  const hintedRuntimeEnvironmentId = ownerHint?.trim() || null
  const route =
    getFloatingWorkspaceOperationRoute(worktreeId) ??
    (explicitResolution.kind === 'resolved'
      ? explicitResolution.route
      : explicitResolution.kind === 'ambiguous'
        ? null
        : ownerHintProvided && worktreeIsPublished
          ? {
              executionHostId: hintedRuntimeEnvironmentId
                ? (`runtime:${encodeURIComponent(hintedRuntimeEnvironmentId)}` as const)
                : ('local' as const),
              runtimeEnvironmentId: hintedRuntimeEnvironmentId
            }
          : resolveEditorOwnerRoute(state, worktreeId))
  if (!route || (ownerHintProvided && (ownerHint?.trim() || null) !== route.runtimeEnvironmentId)) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  const expectedSshConnectionGeneration = getExpectedSshConnectionGeneration(state, route)
  return {
    generation: captureWorktreeOperationGenerationSnapshot(route),
    ownershipProjection,
    ...(expectedSshConnectionGeneration === undefined ? {} : { expectedSshConnectionGeneration })
  }
}

function resolveEditorOwnerRoute(
  state: EditorOwnerState,
  worktreeId: string,
  capturedHostId?: ExecutionHostId | null
): WorktreeOperationRoute | null {
  // Workspace focus cannot replace a file's catalog owner.
  const ownerState = { ...state, activeWorktreeId: null, activeWorkspaceExecutionHostId: null }
  const route = resolveWorktreeOperationRoute(ownerState, worktreeId)
  const scope = parseWorkspaceKey(worktreeId)
  const hostId =
    capturedHostId ??
    (state.activeWorktreeId === worktreeId ? state.activeWorkspaceExecutionHostId : null)
  if (route || scope?.type !== 'folder' || !hostId) {
    return route
  }
  // Same-id folders may use a host qualifier only when the catalog confirms that owner.
  const folder = findFolderWorkspaceOwner(ownerState, scope.folderWorkspaceId, hostId)
  const qualifiedRoute = folder
    ? resolveWorktreeOperationRoute({ ...ownerState, folderWorkspaces: [folder] }, worktreeId)
    : null
  return qualifiedRoute?.executionHostId === hostId ? qualifiedRoute : null
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
    () => resolveCurrentEditorRoute(state, worktreeId, provenance)
  )
  const currentGeneration = getExpectedSshConnectionGeneration(state, route)
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
  const floatingRoute = getFloatingWorkspaceOperationRoute(worktreeId)
  if (floatingRoute) {
    return floatingRoute
  }
  const explicitResolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (explicitResolution.kind === 'resolved') {
    return explicitResolution.route
  }
  if (explicitResolution.kind === 'ambiguous' || provenance.ownershipProjection === 'explicit') {
    return null
  }
  // Why: ordinary folder workspaces have no published worktree row, so re-resolve their live
  // folder owner after preserving the explicit-owner fail-closed contract above (#10251).
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return resolveEditorOwnerRoute(state, worktreeId, provenance.generation.route.executionHostId)
  }
  return isWorktreePublished(state, worktreeId) ? provenance.generation.route : null
}

function isWorktreePublished(state: EditorOwnerState, worktreeId: string): boolean {
  return (
    Object.values(state.worktreesByRepo ?? {}).some((worktrees) =>
      worktrees.some((worktree) => worktree.id === worktreeId)
    ) ||
    Object.values(state.detectedWorktreesByRepo ?? {}).some((result) =>
      result.worktrees.some((worktree) => worktree.id === worktreeId)
    )
  )
}

export function getEditorFileOperationContext(
  state: AppState,
  file: {
    worktreeId: string
    runtimeEnvironmentId?: string | null
    externalSshTargetId?: string
    operationProvenance?: EditorFileOperationProvenance
  },
  worktreePath: string | null
): {
  target: RuntimeClientTarget
  worktreeId: string
  worktreePath: string | null
  connectionId?: string
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedExecutionHostId: 'local' | `ssh:${string}`
} {
  const provenance =
    file.operationProvenance ??
    captureEditorFileOperationProvenance(
      state,
      file.worktreeId,
      file.runtimeEnvironmentId,
      file.runtimeEnvironmentId !== undefined
    )
  const route = file.operationProvenance
    ? assertEditorFileOperationCurrent(state, file.worktreeId, provenance)
    : provenance.generation.route
  const host = parseExecutionHostId(route.executionHostId)
  const workspaceScope = parseWorkspaceKey(file.worktreeId)
  const resolvedWorktreePath =
    (worktreePath?.trim() ? worktreePath : null) ??
    (workspaceScope?.type === 'folder'
      ? (state.folderWorkspaces.find(
          (workspace) => workspace.id === workspaceScope.folderWorkspaceId
        )?.folderPath ?? null)
      : null)
  if (!host) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  const externalSshTargetId = file.externalSshTargetId?.trim()
  if (
    externalSshTargetId &&
    (host.kind !== 'ssh' ||
      route.runtimeEnvironmentId !== null ||
      host.targetId !== externalSshTargetId)
  ) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  if (host?.kind === 'ssh' && provenance.expectedSshConnectionGeneration === undefined) {
    // Why: an old/partial SSH publication may be readable but cannot safely authorize mutations.
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  return {
    target: runtimeTargetForOwnerEnvironment(route.runtimeEnvironmentId),
    worktreeId: file.worktreeId,
    worktreePath: resolvedWorktreePath,
    expectedExecutionHostId: host.kind === 'ssh' ? host.id : 'local',
    ...(route.runtimeEnvironmentId === null && host?.kind === 'ssh'
      ? { connectionId: host.targetId }
      : {}),
    ...(host?.kind === 'ssh' ? { expectedSshTargetId: host.targetId } : {}),
    ...(provenance.expectedSshConnectionGeneration === undefined
      ? {}
      : { expectedSshConnectionGeneration: provenance.expectedSshConnectionGeneration })
  }
}

function getExpectedSshConnectionGeneration(
  state: Pick<AppState, 'sshConnectionStates' | 'sshStateByEnvironment'>,
  route: WorktreeOperationRoute
): number | undefined {
  const host = parseExecutionHostId(route.executionHostId)
  if (host?.kind !== 'ssh') {
    return undefined
  }
  return route.runtimeEnvironmentId
    ? state.sshStateByEnvironment
        .get(route.runtimeEnvironmentId)
        ?.connectionStates.get(host.targetId)?.connectionGeneration
    : state.sshConnectionStates.get(host.targetId)?.connectionGeneration
}
