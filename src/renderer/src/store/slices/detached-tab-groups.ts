import type { StateCreator } from 'zustand'
import type { AuxWindowBounds } from '../../../../shared/aux-window'
import type { AppState } from '../types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'

type DetachedTabGroupState = Pick<
  AppState,
  'detachedGroupIds' | 'auxWindowBoundsByGroupId' | 'groupsByWorktree' | 'unifiedTabsByWorktree'
>

function liveGroupIds(groupsByWorktree: Record<string, TabGroup[]>): Set<string> {
  return new Set(
    Object.values(groupsByWorktree).flatMap((groups) => groups.map((group) => group.id))
  )
}

function terminalOnlyGroupIds(
  groupsByWorktree: Record<string, TabGroup[]>,
  unifiedTabsByWorktree: Record<string, Tab[]>
): Set<string> {
  const eligible = new Set<string>()
  for (const [worktreeId, groups] of Object.entries(groupsByWorktree)) {
    const tabsById = new Map(
      (unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab] as const)
    )
    for (const group of groups) {
      if (
        group.tabOrder.length > 0 &&
        group.tabOrder.every((tabId) => tabsById.get(tabId)?.contentType === 'terminal')
      ) {
        eligible.add(group.id)
      }
    }
  }
  return eligible
}

export function buildDetachedTabGroupIntegrityPatch(
  state: DetachedTabGroupState,
  next: Partial<Pick<DetachedTabGroupState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>> = {}
): Partial<Pick<AppState, 'detachedGroupIds' | 'auxWindowBoundsByGroupId'>> {
  const groupsByWorktree = next.groupsByWorktree ?? state.groupsByWorktree
  const unifiedTabsByWorktree = next.unifiedTabsByWorktree ?? state.unifiedTabsByWorktree
  const currentDetachedGroupIds = state.detachedGroupIds ?? []
  const currentBounds = state.auxWindowBoundsByGroupId ?? {}
  if (currentDetachedGroupIds.length === 0 && Object.keys(currentBounds).length === 0) {
    return {}
  }
  const liveIds = liveGroupIds(groupsByWorktree)
  const eligibleIds =
    currentDetachedGroupIds.length > 0
      ? terminalOnlyGroupIds(groupsByWorktree, unifiedTabsByWorktree)
      : null
  const detachedGroupIds =
    eligibleIds === null
      ? currentDetachedGroupIds
      : currentDetachedGroupIds.filter((groupId) => eligibleIds.has(groupId))
  const auxWindowBoundsByGroupId = Object.fromEntries(
    Object.entries(currentBounds).filter(([groupId]) => liveIds.has(groupId))
  )
  return {
    ...(detachedGroupIds.length !== currentDetachedGroupIds.length ? { detachedGroupIds } : {}),
    ...(Object.keys(auxWindowBoundsByGroupId).length !== Object.keys(currentBounds).length
      ? { auxWindowBoundsByGroupId }
      : {})
  }
}

export type DetachedTabGroupsSlice = {
  /**
   * Tab groups rendered into their own OS window instead of the main layout.
   * Persisted in the workspace session so the windows reopen on restart.
   */
  detachedGroupIds: string[]
  /** Last known screen bounds per detached group, so a window reopens in place. */
  auxWindowBoundsByGroupId: Record<string, AuxWindowBounds>
  detachTabGroup: (groupId: string) => void
  reattachTabGroup: (groupId: string) => void
  recordAuxWindowBounds: (groupId: string, bounds: AuxWindowBounds) => void
  hydrateDetachedTabGroups: (
    detachedGroupIds: string[],
    auxWindowBoundsByGroupId: Record<string, AuxWindowBounds>
  ) => void
}

export const createDetachedTabGroupsSlice: StateCreator<
  AppState,
  [],
  [],
  DetachedTabGroupsSlice
> = (set) => ({
  detachedGroupIds: [],
  auxWindowBoundsByGroupId: {},
  detachTabGroup: (groupId) =>
    set((state) => {
      if (state.detachedGroupIds.includes(groupId)) {
        return state
      }
      const eligibleIds = terminalOnlyGroupIds(state.groupsByWorktree, state.unifiedTabsByWorktree)
      return eligibleIds.has(groupId)
        ? { detachedGroupIds: [...state.detachedGroupIds, groupId] }
        : state
    }),
  reattachTabGroup: (groupId) =>
    set((state) =>
      state.detachedGroupIds.includes(groupId)
        ? { detachedGroupIds: state.detachedGroupIds.filter((id) => id !== groupId) }
        : state
    ),
  recordAuxWindowBounds: (groupId, bounds) =>
    set((state) => {
      if (!liveGroupIds(state.groupsByWorktree).has(groupId)) {
        return state
      }
      const previous = state.auxWindowBoundsByGroupId[groupId]
      if (
        previous &&
        previous.x === bounds.x &&
        previous.y === bounds.y &&
        previous.width === bounds.width &&
        previous.height === bounds.height
      ) {
        return state
      }
      return {
        auxWindowBoundsByGroupId: { ...state.auxWindowBoundsByGroupId, [groupId]: bounds }
      }
    }),
  hydrateDetachedTabGroups: (detachedGroupIds, auxWindowBoundsByGroupId) =>
    set((state) => {
      const candidate = {
        ...state,
        detachedGroupIds: [...detachedGroupIds],
        auxWindowBoundsByGroupId: { ...auxWindowBoundsByGroupId }
      }
      const patch = buildDetachedTabGroupIntegrityPatch(candidate)
      return {
        detachedGroupIds: patch.detachedGroupIds ?? candidate.detachedGroupIds,
        auxWindowBoundsByGroupId:
          patch.auxWindowBoundsByGroupId ?? candidate.auxWindowBoundsByGroupId
      }
    })
})
