import { getLineageUpdateOwnership } from './worktree-lineage-update-ownership'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type {
  WorkspaceLineage,
  WorktreeLineage
} from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import { projectWorktreeLineageToWorkspaceLineage } from './worktree-lineage-workspace-projection'
export { projectWorktreeLineageToWorkspaceLineage } from './worktree-lineage-workspace-projection'
import {
  getSettingsFocusedExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { replaceWorktreeInRepoLists } from '../listing/worktree-owner-settings'
import { withRepoHostOwnership } from '../listing/worktree-host-ownership'
import { mergeLineageForHost, mergeWorkspaceLineageForHost } from './worktree-lineage-host-merge'
import type {
  BackgroundRuntimeRefreshOptions,
  WorktreeLineageUpdateResult,
  WorktreeWithLineage
} from '../listing/worktree-slice-types'

/** Per-row baseline the reply is merged against, so any local write since then outranks it. */
type LineageAtRequestStart = {
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
}

function captureLineageAtRequestStart(
  state: Pick<AppState, 'worktreeLineageById' | 'workspaceLineageByChildKey'>
): LineageAtRequestStart {
  return {
    worktreeLineageById: state.worktreeLineageById,
    workspaceLineageByChildKey: state.workspaceLineageByChildKey
  }
}

export async function listWorktreeLineageForRuntime(
  settings: AppState['settings'],
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<{
  worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
  workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
}> {
  const target = getActiveRuntimeTarget(settings)
  type LineageListResponse = {
    lineage?: Record<string, WorktreeLineage>
    workspaceLineage?: Record<string, WorkspaceLineage>
  }
  const normalizeLineageResponse = (
    value: Record<string, WorktreeLineage> | LineageListResponse
  ) =>
    Object.hasOwn(value, 'lineage') || Object.hasOwn(value, 'workspaceLineage')
      ? {
          worktreeLineageById: (value as LineageListResponse).lineage ?? {},
          workspaceLineageByChildKey: (value as LineageListResponse).workspaceLineage ?? {}
        }
      : {
          worktreeLineageById: value as Record<string, WorktreeLineage>,
          workspaceLineageByChildKey: {}
        }
  if (target.kind === 'local') {
    return normalizeLineageResponse(await window.api.worktrees.listLineage())
  }
  return normalizeLineageResponse(
    await callRuntimeRpc<{
      lineage: Record<string, WorktreeLineage>
      workspaceLineage?: Record<string, WorkspaceLineage>
    }>(target, 'worktree.lineageList', undefined, {
      timeoutMs: 15_000,
      reuseRecentCompatibilityFailure: options.reuseRecentCompatibilityFailure
    })
  )
}

export async function setWorktreeLineageForRuntime(
  settings: AppState['settings'],
  worktreeId: string,
  args: { parentWorktreeId?: string; noParent?: boolean }
): Promise<WorktreeLineageUpdateResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    return {
      target,
      lineage: await window.api.worktrees.updateLineage({ worktreeId, ...args })
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
    lineage: result.worktree.lineage ?? null,
    updatedRemoteWorktree: result.worktree
  }
}

export function projectLocalWorktreeLineageUpdate(
  worktreesByRepo: Record<string, Worktree[]>,
  worktreeId: string,
  lineage: WorktreeLineage | null,
  belongsToHost?: (worktree: Worktree) => boolean
): Record<string, Worktree[]> {
  let nextByRepo = worktreesByRepo
  for (const [repoId, worktrees] of Object.entries(worktreesByRepo)) {
    let repoChanged = false
    const projected = worktrees.map((worktree) => {
      if (belongsToHost && !belongsToHost(worktree)) {
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
  result: WorktreeLineageUpdateResult,
  executionHostId?: ExecutionHostId
): void {
  set((s) => {
    const { belongsToOwner, preserveExisting, preserveWorkspaceEdge } = getLineageUpdateOwnership(
      s,
      worktreeId,
      result,
      executionHostId
    )
    const next = { ...s.worktreeLineageById }
    if (result.lineage && !preserveExisting) {
      next[worktreeId] = result.lineage
    } else if (!preserveExisting) {
      delete next[worktreeId]
    }
    const worktreesByRepo =
      result.target.kind === 'local'
        ? projectLocalWorktreeLineageUpdate(
            s.worktreesByRepo,
            worktreeId,
            result.lineage,
            belongsToOwner
          )
        : result.updatedRemoteWorktree
          ? replaceWorktreeInRepoLists(
              s.worktreesByRepo,
              withRepoHostOwnership(
                result.updatedRemoteWorktree,
                toRuntimeExecutionHostId(result.target.environmentId)
              )
            )
          : s.worktreesByRepo
    return {
      worktreeLineageById: next,
      workspaceLineageByChildKey: preserveWorkspaceEdge
        ? s.workspaceLineageByChildKey
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
  lineage: {
    worktreeLineageById: Readonly<Record<string, WorktreeLineage>>
    workspaceLineageByChildKey: Readonly<Record<string, WorkspaceLineage>>
  },
  lineageAtRequestStart?: LineageAtRequestStart
): void {
  set((s) => {
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
      workspaceLineageByChildKey === s.workspaceLineageByChildKey
    ) {
      return s
    }
    return { worktreeLineageById, workspaceLineageByChildKey }
  })
}

export async function refreshWorktreeLineageForSettings(
  settings: AppState['settings'],
  set: Parameters<StateCreator<AppState>>[0],
  getState: () => Pick<AppState, 'worktreeLineageById' | 'workspaceLineageByChildKey'>,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<void> {
  const lineageAtRequestStart = captureLineageAtRequestStart(getState())
  const lineage = await listWorktreeLineageForRuntime(settings, options)
  applyHostLineageRefresh(
    set,
    getSettingsFocusedExecutionHostId(settings),
    lineage,
    lineageAtRequestStart
  )
}

export async function refreshRemoteWorktreeLineageBestEffort(
  settings: AppState['settings'],
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  getState: () => Pick<AppState, 'worktreeLineageById' | 'workspaceLineageByChildKey'>
): Promise<void> {
  if (getActiveRuntimeTarget(settings).kind === 'local') {
    return
  }
  try {
    const lineageAtRequestStart = captureLineageAtRequestStart(getState())
    const lineage = await listWorktreeLineageForRuntime(settings, {
      reuseRecentCompatibilityFailure: true
    })
    applyHostLineageRefresh(
      set,
      getSettingsFocusedExecutionHostId(settings),
      lineage,
      lineageAtRequestStart
    )
  } catch (err) {
    // Why: lineage is supplemental, so a remote timeout here must not discard a successful worktree refresh.
    console.error('Failed to fetch worktree lineage:', err)
  }
}
