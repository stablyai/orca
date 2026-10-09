import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import {
  getRepoIdFromWorktreeId,
  type WorktreePassiveMetadataOwner,
  type WorktreeMetaUpdateGuard
} from '../../worktree-helpers'
import { findRepoForHost } from '../../repo-host-identity'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost,
  settingsForWorktreeOperationRoute,
  type WorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import { WORKTREE_REMOVAL_AMBIGUOUS_ERROR } from './worktree-slice-constants'
import { isRuntimeSelectorNotFoundError } from './runtime-worktree-rpc-errors'
import { persistWorktreeMeta } from '../metadata/worktree-meta-persist'
import type { WorktreeSliceGet } from './worktree-slice-types'
import { findKnownWorktreeById } from './detected-worktree-meta'
import { getWorktreeInstanceId } from '../../../../../../shared/worktree/identity'

export function replaceWorktreeInRepoLists(
  worktreesByRepo: Record<string, Worktree[]>,
  updatedWorktree: Worktree
): Record<string, Worktree[]> {
  const repoId = getRepoIdFromWorktreeId(updatedWorktree.id)
  const current = worktreesByRepo[repoId]
  if (!current) {
    return worktreesByRepo
  }
  return {
    ...worktreesByRepo,
    [repoId]: current.map((worktree) =>
      worktree.id === updatedWorktree.id ? updatedWorktree : worktree
    )
  }
}

export function settingsForRepoOwner(
  state: Pick<AppState, 'repos' | 'settings'>,
  repoId: string,
  hostId?: ExecutionHostId | null,
  honorMissingHostId = false
) {
  const repo = findRepoForHost(state.repos, repoId, { hostId, settings: state.settings })
  if (repo) {
    return settingsForKnownRepoOwner(state.settings, repo)
  }
  const parsedHost = honorMissingHostId && hostId ? parseExecutionHostId(hostId) : null
  if (parsedHost?.kind === 'runtime') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: parsedHost.environmentId }
      : ({ activeRuntimeEnvironmentId: parsedHost.environmentId } as AppState['settings'])
  }
  if (parsedHost?.kind === 'local' || parsedHost?.kind === 'ssh') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: null }
      : ({ activeRuntimeEnvironmentId: null } as AppState['settings'])
  }
  return state.settings
}

export function settingsForKnownRepoOwner(
  settings: AppState['settings'],
  repo: { connectionId?: string | null; executionHostId?: ExecutionHostId | null }
) {
  if (!repo.executionHostId && !repo.connectionId) {
    return settings
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (parsed?.kind === 'runtime') {
    return settings
      ? { ...settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : ({ activeRuntimeEnvironmentId: parsed.environmentId } as AppState['settings'])
  }
  if (parsed?.kind === 'local' && settings?.activeRuntimeEnvironmentId) {
    return { ...settings, activeRuntimeEnvironmentId: null }
  }
  if (parsed?.kind !== 'ssh') {
    return settings
  }
  // Why: SSH repos are owned by the desktop client/SSH provider, not the focused runtime server.
  return settings
    ? { ...settings, activeRuntimeEnvironmentId: null }
    : ({ activeRuntimeEnvironmentId: null } as AppState['settings'])
}

export function trySettingsForWorktreeOwner(
  state: Pick<
    AppState,
    | 'repos'
    | 'settings'
    | 'worktreesByRepo'
    | 'detectedWorktreesByRepo'
    | 'folderWorkspaces'
    | 'projectGroups'
    | 'restoredRuntimeHostIdByWorkspaceSessionKey'
    | 'runtimeEnvironments'
    | 'runtimeEnvironmentCatalogHydrated'
    | 'removedRuntimeEnvironmentIds'
  >,
  worktreeId: string,
  executionHostId?: ExecutionHostId
): AppState['settings'] | null {
  const route = executionHostId
    ? resolveWorktreeOperationRouteForHost(state, worktreeId, executionHostId)
    : resolveWorktreeOperationRoute(state, worktreeId)
  if (!route) {
    return null
  }
  return settingsForWorktreeOperationRoute(state.settings, route)
}

export function settingsForWorktreeOwner(
  state: Parameters<typeof trySettingsForWorktreeOwner>[0],
  worktreeId: string,
  executionHostId?: ExecutionHostId
) {
  const settings = trySettingsForWorktreeOwner(state, worktreeId, executionHostId)
  if (!settings) {
    throw new Error(WORKTREE_REMOVAL_AMBIGUOUS_ERROR)
  }
  return settings
}

// Why: activity bumps fire on every PTY event, so an ambiguous workspace would warn continuously.
// One line per workspace is enough to diagnose it (#10634).
export const ambiguousOwnerWarnedWorktreeIds = new Set<string>()

/** Re-arms the once-per-workspace warning; called from every worktree teardown path. */
export function forgetAmbiguousOwnerWarnings(worktreeIds: Iterable<string>): void {
  for (const worktreeId of worktreeIds) {
    ambiguousOwnerWarnedWorktreeIds.delete(worktreeId)
  }
}

export function warnAmbiguousOwnerOnce(worktreeId: string, errorLabel: string): void {
  if (ambiguousOwnerWarnedWorktreeIds.has(worktreeId)) {
    return
  }
  ambiguousOwnerWarnedWorktreeIds.add(worktreeId)
  console.warn(`Skipped ${errorLabel}: workspace identity is ambiguous across hosts`, worktreeId)
}

function sameRoute(left: WorktreeOperationRoute | null, right: WorktreeOperationRoute): boolean {
  return (
    left?.executionHostId === right.executionHostId &&
    left.runtimeEnvironmentId === right.runtimeEnvironmentId
  )
}

function findPassiveWorktreeForRoute(
  state: AppState,
  worktreeId: string,
  route: WorktreeOperationRoute
) {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const matches = (worktree: {
    id: string
    repoId: string
    hostId?: ExecutionHostId
    runtimeOwnerEnvironmentId?: string
  }) => {
    const exact = resolveExactWorktreeRoute(state, worktree)
    return worktree.id === worktreeId && exact.kind === 'resolved' && sameRoute(exact.route, route)
  }
  const visible = (state.worktreesByRepo?.[repoId] ?? []).filter(matches)
  if (visible.length) {
    return visible.length === 1 ? visible[0] : undefined
  }
  const detected = (state.detectedWorktreesByRepo?.[repoId]?.worktrees ?? []).filter(matches)
  if (detected.length) {
    return detected.length === 1 ? detected[0] : undefined
  }
  if (!state.worktreesByRepo || !state.detectedWorktreesByRepo) {
    return undefined
  }
  const legacy = findKnownWorktreeById(state, worktreeId)
  return legacy &&
    !legacy.hostId &&
    !legacy.runtimeOwnerEnvironmentId &&
    sameRoute(resolveWorktreeOperationRoute(state, worktreeId), route)
    ? legacy
    : undefined
}

export function resolvePassiveWorktreeMetaOwner(
  state: AppState,
  worktreeId: string,
  qualification?: WorktreePassiveMetadataOwner | null
) {
  if (qualification === null) {
    return undefined
  }
  const route = qualification ?? resolveWorktreeOperationRoute(state, worktreeId)
  if (!route) {
    if (findKnownWorktreeById(state, worktreeId)) {
      warnAmbiguousOwnerOnce(worktreeId, 'persist worktree metadata')
    }
    return undefined
  }
  const worktree = findPassiveWorktreeForRoute(state, worktreeId, route)
  if (
    !worktree ||
    (qualification?.expectedInstanceId !== undefined &&
      getWorktreeInstanceId(worktree) !== qualification.expectedInstanceId)
  ) {
    return undefined
  }
  return { worktree, route }
}

export function passiveWorktreeMetaUpdateGuard(
  captured: NonNullable<Parameters<WorktreeMetaUpdateGuard>[0]>
): WorktreeMetaUpdateGuard {
  const instanceId = getWorktreeInstanceId(captured)
  return (worktree) =>
    worktree !== undefined &&
    worktree.runtimeOwnerEnvironmentId === captured.runtimeOwnerEnvironmentId &&
    getWorktreeInstanceId(worktree) === instanceId
}

export function capturePassiveWorktreeMetaOwner(
  state: AppState,
  worktreeId: string,
  route: WorktreeOperationRoute
): WorktreePassiveMetadataOwner {
  const owner = resolvePassiveWorktreeMetaOwner(state, worktreeId, route)
  const expectedInstanceId = owner ? getWorktreeInstanceId(owner.worktree) : undefined
  return { ...route, ...(expectedInstanceId ? { expectedInstanceId } : {}) }
}

export function persistPassiveWorktreeMetaForOwner(
  get: WorktreeSliceGet,
  worktreeId: string,
  updates: Partial<WorktreeMeta>,
  errorLabel: string,
  options: {
    owner?: NonNullable<ReturnType<typeof resolvePassiveWorktreeMetaOwner>>
    reconcileSelectorMiss?: boolean
  } = {}
): void {
  const state = get()
  const owner = options.owner ?? resolvePassiveWorktreeMetaOwner(state, worktreeId)
  if (!owner) {
    warnAmbiguousOwnerOnce(worktreeId, errorLabel)
    return
  }
  const { worktree, route } = owner
  const ownerSettings = settingsForWorktreeOperationRoute(state.settings, route)
  void persistWorktreeMeta(
    ownerSettings,
    worktreeId,
    updates,
    worktree.identity?.executionHostId ?? worktree.hostId ?? route.executionHostId ?? undefined,
    worktree.identity?.key,
    getWorktreeInstanceId(worktree)
  ).catch((err) => {
    if (isRuntimeSelectorNotFoundError(err)) {
      if (options.reconcileSelectorMiss !== false) {
        void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      }
      return
    }
    console.error(`Failed to ${errorLabel}:`, err)
    void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
  })
}
