import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { callRuntimeRpc } from '../../../../runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  getRuntimeTargetHostId,
  type HostRoute
} from '../../../../runtime/rpc/targets/runtime-client-target'
import { toRuntimeWorktreeSelector } from '../../../../runtime/rpc/targets/runtime-worktree-selector'
import { OWN_LINEAGE_STORE_KEY } from '../../../../../../shared/worktree/cross-store-lineage-resolution'
import {
  lineageStoreKeyOfTarget,
  withoutChildCrossStoreLineage,
  withStoreCrossStoreLineage,
  type HostLineageList
} from './cross-store-lineage-state'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { replaceWorktreeInRepoLists } from '../listing/worktree-owner-settings'
import {
  withRepoHostOwnership,
  worktreeHostMatchOptions,
  worktreeMatchesHost
} from '../listing/worktree-host-ownership'
import { mergeLineageForHost, mergeWorkspaceLineageForHost } from './worktree-lineage-host-merge'
import {
  projectWorktreeLineageToWorkspaceLineage,
  withWorkspaceLineage
} from './workspace-lineage-update-projection'
import { beginWorktreeLineageRefresh } from './worktree-lineage-readiness'
import type {
  BackgroundRuntimeRefreshOptions,
  WorktreeLineageUpdateResult,
  WorktreeWithLineage
} from '../listing/worktree-slice-types'

/** Per-row baseline the reply is merged against, so any local write since then outranks it. */
type LineageAtRequestStart = {
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
  crossStoreLineageByStoreKey?: AppState['crossStoreLineageByStoreKey']
}

type LineageRefreshState = Pick<
  AppState,
  'worktreeLineageById' | 'workspaceLineageByChildKey' | 'crossStoreLineageByStoreKey'
>

function captureLineageAtRequestStart(state: LineageRefreshState): LineageAtRequestStart {
  return {
    crossStoreLineageByStoreKey: state.crossStoreLineageByStoreKey,
    worktreeLineageById: state.worktreeLineageById,
    workspaceLineageByChildKey: state.workspaceLineageByChildKey
  }
}

export async function listWorktreeLineageForRuntime(
  target: RuntimeClientTarget,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<HostLineageList> {
  type LineageListResponse = {
    lineage?: Record<string, WorktreeLineage>
    workspaceLineage?: Record<string, WorkspaceLineage>
    crossStoreLineage?: Record<string, unknown>
    installationId?: string
  }
  const normalizeLineageResponse = (
    value: Record<string, WorktreeLineage> | LineageListResponse
  ): HostLineageList =>
    Object.hasOwn(value, 'lineage') || Object.hasOwn(value, 'workspaceLineage')
      ? {
          worktreeLineageById: (value as LineageListResponse).lineage ?? {},
          workspaceLineageByChildKey: (value as LineageListResponse).workspaceLineage ?? {},
          crossStoreLineageByChildKey: (value as LineageListResponse).crossStoreLineage,
          installationId: (value as LineageListResponse).installationId
        }
      : {
          worktreeLineageById: value as Record<string, WorktreeLineage>,
          workspaceLineageByChildKey: {}
        }
  if (target.kind === 'local') {
    return normalizeLineageResponse(await window.api.worktrees.listLineage())
  }
  return normalizeLineageResponse(
    await callRuntimeRpc<LineageListResponse>(target, 'worktree.lineageList', undefined, {
      timeoutMs: 15_000,
      reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
    })
  )
}

export async function setWorktreeLineageForRuntime(
  route: HostRoute,
  worktreeId: string,
  args: { parentWorktreeId?: string; noParent?: boolean }
): Promise<WorktreeLineageUpdateResult> {
  const { target } = route
  if (target.kind === 'local') {
    return {
      target,
      hostId: route.at,
      ...(await window.api.worktrees.updateLineage({ worktreeId, ...args }))
    }
  }
  const result = await callRuntimeRpc<{ worktree: WorktreeWithLineage }>(
    target,
    'worktree.set',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      ...(args.parentWorktreeId
        ? { parentWorktree: toRuntimeWorktreeSelector(args.parentWorktreeId) }
        : {}),
      ...(args.noParent === true ? { noParent: true } : {})
    },
    { timeoutMs: 15_000 }
  )
  return {
    target,
    hostId: getRuntimeTargetHostId(target),
    lineage: result.worktree.lineage ?? null,
    ...(result.worktree.workspaceLineage !== undefined
      ? { workspaceLineage: result.worktree.workspaceLineage }
      : {}),
    updatedRemoteWorktree: result.worktree
  }
}

/** Projects a local write onto this host's rows only; a same-id twin on a server keeps its own. */
export function projectLocalWorktreeLineageUpdate(
  state: Pick<AppState, 'repos' | 'worktreesByRepo'>,
  hostId: ExecutionHostId,
  worktreeId: string,
  lineage: WorktreeLineage | null
): Record<string, Worktree[]> {
  const { worktreesByRepo } = state
  let nextByRepo = worktreesByRepo
  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    const options = worktreeHostMatchOptions(state, repoId, hostId)
    let repoChanged = false
    const projected = worktrees.map((worktree) => {
      if (!worktreeMatchesHost(worktree, hostId, options)) {
        return worktree
      }
      const current = worktree as WorktreeWithLineage
      const hadChild = current.childWorktreeIds?.includes(worktreeId) ?? false
      const isParent =
        lineage?.parentWorktreeId === worktree.id &&
        lineage.parentWorktreeInstanceId === worktree.instanceId
      let childWorktreeIds = current.childWorktreeIds
      if (hadChild) {
        childWorktreeIds = childWorktreeIds?.filter((id) => id !== worktreeId)
      }
      if (isParent && !childWorktreeIds?.includes(worktreeId)) {
        childWorktreeIds = [...(childWorktreeIds ?? []), worktreeId]
      }
      if (worktree.id === worktreeId) {
        repoChanged = true
        return {
          ...worktree,
          parentWorktreeId: lineage?.parentWorktreeId ?? null,
          lineage
        }
      }
      if (hadChild || isParent) {
        repoChanged = true
        return { ...worktree, childWorktreeIds }
      }
      return worktree
    })
    if (repoChanged) {
      if (nextByRepo === worktreesByRepo) {
        nextByRepo = { ...worktreesByRepo }
      }
      nextByRepo[repoId] = projected
    }
  }
  return nextByRepo
}

export function applyWorktreeLineageUpdate(
  set: Parameters<StateCreator<AppState>>[0],
  worktreeId: string,
  result: WorktreeLineageUpdateResult
): void {
  set((s) => {
    const next = { ...s.worktreeLineageById }
    if (result.lineage) {
      next[worktreeId] = result.lineage
    } else {
      delete next[worktreeId]
    }
    // Why the result's host: focus can name the twin of a row another host just answered for.
    const worktreesByRepo =
      result.target.kind === 'local'
        ? projectLocalWorktreeLineageUpdate(s, result.hostId, worktreeId, result.lineage)
        : result.updatedRemoteWorktree
          ? replaceWorktreeInRepoLists(
              s,
              withRepoHostOwnership(result.updatedRemoteWorktree, result.hostId),
              result.hostId
            )
          : s.worktreesByRepo
    return {
      // The host clears a child's cross-store parent on every same-store set or remove.
      crossStoreLineageByStoreKey: withoutChildCrossStoreLineage(s, result.target, worktreeId),
      worktreeLineageById: next,
      // Older hosts report only the worktree lineage, which is the workspace record's projection.
      workspaceLineageByChildKey:
        result.workspaceLineage !== undefined
          ? withWorkspaceLineage(s.workspaceLineageByChildKey, worktreeId, result.workspaceLineage)
          : projectWorktreeLineageToWorkspaceLineage(
              worktreeId,
              result.lineage,
              s.workspaceLineageByChildKey
            ),
      worktreesByRepo,
      sortEpoch: s.sortEpoch + 1
    }
  })
}

export function applyHostLineageRefresh(
  set: Parameters<StateCreator<AppState>>[0],
  hostId: ExecutionHostId,
  lineage: HostLineageList,
  lineageAtRequestStart?: LineageAtRequestStart,
  storeKey = OWN_LINEAGE_STORE_KEY
): void {
  set((s) => {
    const crossStore = withStoreCrossStoreLineage(s, storeKey, lineage, lineageAtRequestStart)
    const worktreeLineageById = mergeLineageForHost(
      s,
      hostId,
      lineage.worktreeLineageById,
      lineageAtRequestStart?.worktreeLineageById
    )
    const workspaceLineageByChildKey = mergeWorkspaceLineageForHost(
      s,
      hostId,
      lineage.workspaceLineageByChildKey,
      lineageAtRequestStart?.workspaceLineageByChildKey
    )
    if (
      worktreeLineageById === s.worktreeLineageById &&
      workspaceLineageByChildKey === s.workspaceLineageByChildKey &&
      Object.keys(crossStore).length === 0
    ) {
      return s
    }
    return { worktreeLineageById, workspaceLineageByChildKey, ...crossStore }
  })
}

export async function refreshWorktreeLineageForTarget(
  target: RuntimeClientTarget,
  set: Parameters<StateCreator<AppState>>[0],
  getState: () => LineageRefreshState,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<void> {
  const finish = beginWorktreeLineageRefresh(getState, target)
  let succeeded = false
  try {
    const lineageAtRequestStart = captureLineageAtRequestStart(getState())
    const lineage = await listWorktreeLineageForRuntime(target, options)
    const storeKey = lineageStoreKeyOfTarget(target)
    applyHostLineageRefresh(
      set,
      getRuntimeTargetHostId(target),
      lineage,
      lineageAtRequestStart,
      storeKey
    )
    succeeded = true
  } finally {
    finish(succeeded)
  }
}

export async function refreshRemoteWorktreeLineageBestEffort(
  target: RuntimeClientTarget | null,
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  getState: () => LineageRefreshState
): Promise<void> {
  if (target?.kind !== 'environment') {
    return
  }
  try {
    await refreshWorktreeLineageForTarget(target, set, getState, {
      reuseRecentCompatibilityFailure: true
    })
  } catch (err) {
    // Why: lineage is supplemental, so a remote timeout here must not discard a successful worktree refresh.
    console.error('Failed to fetch worktree lineage:', err)
  }
}
