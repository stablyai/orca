import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { LayoutFrameSlices } from './frames/workspace-layout-frame-slices'
import { pickVisibleLandingTabId } from '../../../../shared/workspace-layout/tab-groups/worker-tab-visibility'
// Read-only runtime layout copy (design 3.3); the owner switch derives store slices from it.

import { stableJson } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-report'
import type { PublishedWorkspaceLayout } from '../../../../shared/workspace-layout/published-layout/workspace-layout-published'
import { applyWorkspaceLayoutRecordChange } from '../../../../shared/workspace-layout/published-layout/workspace-layout-records'
import type { WorkspaceLayoutChangeFrame } from '../../../../shared/workspace-layout/published-layout/workspace-layout-stream-frames'

export type WorkspaceLayoutCache = Readonly<Record<string, PublishedWorkspaceLayout>>

export const EMPTY_WORKSPACE_LAYOUT_CACHE: WorkspaceLayoutCache = {}

/** Only writer (design 3.3 applyFromRuntime); keep identity when unchanged. Invalid records throw so callers refetch the stream. */
export function applyLayoutFrame(
  cache: WorkspaceLayoutCache,
  frame: WorkspaceLayoutChangeFrame
): WorkspaceLayoutCache {
  switch (frame.type) {
    case 'workspace':
      // The runtime publishes a workspace only when it changed.
      return { ...cache, [frame.key]: frame.layout }
    case 'removed': {
      if (!(frame.key in cache)) {
        return cache
      }
      const { [frame.key]: _removed, ...rest } = cache
      return rest
    }
    case 'records': {
      const next: Record<string, PublishedWorkspaceLayout> = { ...cache }
      for (const change of frame.workspaces) {
        const layout = applyWorkspaceLayoutRecordChange(next[change.key], change)
        if (layout) {
          next[change.key] = layout
        } else {
          delete next[change.key]
        }
      }
      return frame.workspaces.length > 0 ? next : cache
    }
    case 'snapshot': {
      // Keeps each equal entry, so a reconnect with unchanged data re-renders nothing.
      const next: Record<string, PublishedWorkspaceLayout> = {}
      let changed = false
      for (const { key, layout } of frame.workspaces) {
        const cached = cache[key]
        const keep = cached !== undefined && stableJson(cached) === stableJson(layout)
        next[key] = keep ? cached : layout
        changed ||= !keep
      }
      return changed || Object.keys(next).length !== Object.keys(cache).length ? next : cache
    }
  }
}

export type FrameWorkerSlices = Pick<
  LayoutFrameSlices,
  | 'unifiedTabsByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'groupsByWorktree'
  | 'activeTabIdByWorktree'
>

/** Apply window selection policy after an authoritative frame supplies membership. */
export function projectWindowFrameSelections<T extends FrameWorkerSlices>(
  state: AppState,
  built: T,
  preservesSelection: (tabs: readonly Tab[]) => boolean,
  foldedTabs: (state: AppState, worktreeId: string, groupId: string) => ReadonlySet<string>
): T {
  const groupsByWorktree = { ...built.groupsByWorktree }
  const activeTabIdByWorktree = { ...built.activeTabIdByWorktree }
  const candidate = {
    ...state,
    ...built,
    unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, ...built.unifiedTabsByWorktree },
    tabsByWorktree: { ...state.tabsByWorktree, ...built.tabsByWorktree },
    terminalLayoutsByTabId: { ...state.terminalLayoutsByTabId, ...built.terminalLayoutsByTabId },
    groupsByWorktree: { ...state.groupsByWorktree, ...groupsByWorktree }
  }
  for (const [worktreeId, groups] of Object.entries(groupsByWorktree)) {
    const tabs = built.unifiedTabsByWorktree[worktreeId] ?? []
    if (!preservesSelection(tabs)) {
      continue
    }
    const previous = new Map(state.groupsByWorktree[worktreeId]?.map((group) => [group.id, group]))
    const retained = groups.map((group) => {
      const recorded = previous.get(group.id)?.activeTabId
      return {
        ...group,
        activeTabId: recorded && group.tabOrder.includes(recorded) ? recorded : null
      }
    })
    candidate.groupsByWorktree[worktreeId] = retained
    groupsByWorktree[worktreeId] = retained.map((group) => {
      if (group.activeTabId) {
        return group
      }
      const folded = foldedTabs(candidate, worktreeId, group.id)
      const activeTabId = pickVisibleLandingTabId(
        group.tabOrder,
        previous.get(group.id)?.recentTabIds,
        folded
      )
      return activeTabId ? { ...group, activeTabId } : group
    })
    const focused = groupsByWorktree[worktreeId]?.find(
      (group) => group.id === state.activeGroupIdByWorktree[worktreeId]
    )
    if (focused?.activeTabId === null) {
      activeTabIdByWorktree[worktreeId] = null
    }
  }
  return { ...built, groupsByWorktree, activeTabIdByWorktree }
}

export function windowGroupSelectionPatch(
  state: AppState,
  worktreeId: string,
  groupId: string,
  selectedTabId: string | null
): Partial<AppState> {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const group = groups.find((candidate) => candidate.id === groupId)
  if (!group || group.activeTabId === selectedTabId) {
    return {}
  }
  const cleared = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.id === group.activeTabId
  )
  const entityId = selectedTabId === null ? cleared?.entityId : undefined
  return {
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [worktreeId]: groups.map((candidate) =>
        candidate.id === groupId ? { ...candidate, activeTabId: selectedTabId } : candidate
      )
    },
    ...(entityId !== undefined && state.activeTabIdByWorktree[worktreeId] === entityId
      ? { activeTabIdByWorktree: { ...state.activeTabIdByWorktree, [worktreeId]: null } }
      : {}),
    ...(entityId !== undefined && state.activeTabId === entityId ? { activeTabId: null } : {})
  }
}
