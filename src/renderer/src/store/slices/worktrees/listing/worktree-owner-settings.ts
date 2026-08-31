import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { findRepoForHost } from '../../repo-host-identity'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost,
  settingsForWorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { WORKTREE_REMOVAL_AMBIGUOUS_ERROR } from './worktree-slice-constants'
import { isRuntimeSelectorNotFoundError } from './runtime-worktree-rpc-errors'
import { persistWorktreeMeta } from '../metadata/worktree-meta-persist'
import type { WorktreeSliceGet } from './worktree-slice-types'

export function replaceWorktreeInRepoLists(
  worktreesByRepo: Record<string, Worktree[]>,
  updatedWorktree: Worktree
): Record<string, Worktree[]> {
  const repoId = getRepoIdFromWorktreeId(updatedWorktree.id)
  const current = worktreesByRepo[repoId]
  if (!current) {
    return worktreesByRepo
  }
  // Worktree ids are path-derived and can repeat across physical hosts. Keep both
  // host and logical runtime namespaces so two SSH targets projected by one HUB do
  // not overwrite one another (#10287, #11163).
  type OwnerIdentity = {
    physicalHostId: string
    runtimeEnvironmentId: string | null
    hostKind: 'local' | 'ssh' | 'runtime' | null
  }
  const ownerIdentity = (worktree: Worktree): OwnerIdentity => {
    const parsedHost = parseExecutionHostId(worktree.hostId)
    const runtimeEnvironmentId =
      worktree.runtimeOwnerEnvironmentId?.trim() ||
      (parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null)
    return {
      // A runtime host is a logical owner rather than a physical SSH target. Keep
      // it as a distinct namespace and only bridge it to one physical row below.
      physicalHostId:
        parsedHost?.kind === 'runtime' ? 'runtime' : (parsedHost?.id ?? worktree.hostId ?? 'local'),
      runtimeEnvironmentId: runtimeEnvironmentId || null,
      hostKind: parsedHost?.kind ?? null
    }
  }
  const updatedOwnerIdentity = ownerIdentity(updatedWorktree)
  const identitiesEqual = (left: OwnerIdentity, right: OwnerIdentity): boolean =>
    left.physicalHostId === right.physicalHostId &&
    left.runtimeEnvironmentId === right.runtimeEnvironmentId
  const isRuntimePhysicalAlias = (left: OwnerIdentity, right: OwnerIdentity): boolean =>
    left.runtimeEnvironmentId !== null &&
    left.runtimeEnvironmentId === right.runtimeEnvironmentId &&
    ((left.hostKind === 'runtime' && right.hostKind !== 'runtime') ||
      (right.hostKind === 'runtime' && left.hostKind !== 'runtime'))
  const exactMatchExists = current.some(
    (worktree) =>
      worktree.id === updatedWorktree.id &&
      identitiesEqual(ownerIdentity(worktree), updatedOwnerIdentity)
  )
  const runtimeAliasCandidates = current.filter(
    (worktree) =>
      worktree.id === updatedWorktree.id &&
      isRuntimePhysicalAlias(ownerIdentity(worktree), updatedOwnerIdentity)
  )
  // Legacy runtime refreshes can omit the physical SSH stamp. Bridge that form
  // only when exactly one physical row is eligible; rival targets remain intact.
  const useRuntimeAlias = !exactMatchExists && runtimeAliasCandidates.length === 1
  return {
    ...worktreesByRepo,
    [repoId]: current.map((worktree) => {
      if (worktree.id !== updatedWorktree.id) {
        return worktree
      }
      const identity = ownerIdentity(worktree)
      return identitiesEqual(identity, updatedOwnerIdentity) ||
        (useRuntimeAlias && isRuntimePhysicalAlias(identity, updatedOwnerIdentity))
        ? updatedWorktree
        : worktree
    })
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

export function warnAmbiguousOwnerOnce(worktreeId: string, errorLabel: string): void {
  if (ambiguousOwnerWarnedWorktreeIds.has(worktreeId)) {
    return
  }
  ambiguousOwnerWarnedWorktreeIds.add(worktreeId)
  console.warn(`Skipped ${errorLabel}: workspace identity is ambiguous across hosts`, worktreeId)
}

export function persistPassiveWorktreeMetaForOwner(
  get: WorktreeSliceGet,
  worktreeId: string,
  updates: Partial<WorktreeMeta>,
  errorLabel: string
): void {
  const ownerSettings = trySettingsForWorktreeOwner(get(), worktreeId)
  if (!ownerSettings) {
    warnAmbiguousOwnerOnce(worktreeId, errorLabel)
    return
  }
  void persistWorktreeMeta(ownerSettings, worktreeId, updates).catch((err) => {
    if (isRuntimeSelectorNotFoundError(err)) {
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
      return
    }
    console.error(`Failed to ${errorLabel}:`, err)
    void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
  })
}
