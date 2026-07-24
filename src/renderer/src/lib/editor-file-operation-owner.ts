import { parseExecutionHostId } from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { AppState } from '@/store/types'
import {
  assertWorktreeOperationGenerationSnapshotCurrent,
  captureWorktreeOperationGenerationSnapshot,
  type WorktreeOperationGenerationSnapshot
} from './worktree-operation-generation'
import {
  resolveExplicitWorktreeOperationRouteResult,
  resolveWorktreeOperationRoute,
  settingsForWorktreeOperationRoute,
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
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
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
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      ? { executionHostId: 'local' as const, runtimeEnvironmentId: null }
      : explicitResolution.kind === 'resolved'
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
            : resolveWorktreeOperationRoute(state, worktreeId)
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
  const explicitResolution = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (explicitResolution.kind === 'resolved') {
    return explicitResolution.route
  }
  if (explicitResolution.kind === 'ambiguous' || provenance.ownershipProjection === 'explicit') {
    return null
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
    operationProvenance?: EditorFileOperationProvenance
  },
  worktreePath: string | null
): {
  settings: AppState['settings']
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
  if (!host) {
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  if (host?.kind === 'ssh' && provenance.expectedSshConnectionGeneration === undefined) {
    // Why: an old/partial SSH publication may be readable but cannot safely authorize mutations.
    throw new Error(OWNER_CHANGED_MESSAGE)
  }
  return {
    settings: settingsForWorktreeOperationRoute(state.settings, route),
    worktreeId: file.worktreeId,
    worktreePath,
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
