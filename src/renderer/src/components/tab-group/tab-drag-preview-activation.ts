import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'

export type TabDragActivationSnapshot = {
  activeGroupId: string | null
  activeTabIdByGroup: Record<string, string | null>
}

function previewActiveSurfacePatch(
  state: AppState,
  worktreeId: string,
  groupId: string,
  tabId: string | null
): Partial<AppState> {
  if (state.activeWorktreeId !== worktreeId || !tabId) {
    return {}
  }
  const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.id === tabId && tab.groupId === groupId
  )
  if (!unifiedTab) {
    return {}
  }

  const nextActiveTabTypeByWorktree = (
    tabType: AppState['activeTabType']
  ): AppState['activeTabTypeByWorktree'] => ({
    ...state.activeTabTypeByWorktree,
    [worktreeId]: tabType
  })

  if (unifiedTab.contentType === 'terminal') {
    return {
      activeTabId: unifiedTab.entityId,
      activeTabType: 'terminal',
      activeTabIdByWorktree: {
        ...state.activeTabIdByWorktree,
        [worktreeId]: unifiedTab.entityId
      },
      activeTabTypeByWorktree: nextActiveTabTypeByWorktree('terminal')
    }
  }
  if (unifiedTab.contentType === 'browser') {
    return {
      activeBrowserTabId: unifiedTab.entityId,
      activeTabType: 'browser',
      activeBrowserTabIdByWorktree: {
        ...state.activeBrowserTabIdByWorktree,
        [worktreeId]: unifiedTab.entityId
      },
      activeTabTypeByWorktree: nextActiveTabTypeByWorktree('browser')
    }
  }
  if (unifiedTab.contentType === 'simulator') {
    return {
      activeTabType: 'simulator',
      activeTabTypeByWorktree: nextActiveTabTypeByWorktree('simulator')
    }
  }
  return {
    activeFileId: unifiedTab.entityId,
    activeTabType: 'editor',
    activeFileIdByWorktree: {
      ...state.activeFileIdByWorktree,
      [worktreeId]: unifiedTab.entityId
    },
    activeTabTypeByWorktree: nextActiveTabTypeByWorktree('editor')
  }
}

export function captureTabDragActivationSnapshot(worktreeId: string): TabDragActivationSnapshot {
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  return {
    activeGroupId: state.activeGroupIdByWorktree[worktreeId] ?? null,
    activeTabIdByGroup: Object.fromEntries(groups.map((group) => [group.id, group.activeTabId]))
  }
}

export function applyDragPreviewTab({
  worktreeId,
  groupId,
  tabId,
  activeGroupId
}: {
  worktreeId: string
  groupId: string
  tabId: string | null
  activeGroupId: string
}): void {
  useAppStore.setState((state): Partial<AppState> => {
    const groups = state.groupsByWorktree[worktreeId] ?? []
    const targetGroup = groups.find((group) => group.id === groupId)
    const groupUnchanged = targetGroup?.activeTabId === tabId
    const focusUnchanged = (state.activeGroupIdByWorktree[worktreeId] ?? null) === activeGroupId
    const surfacePatch = previewActiveSurfacePatch(state, worktreeId, groupId, tabId)
    if (groupUnchanged && focusUnchanged) {
      return Object.keys(surfacePatch).length > 0 ? surfacePatch : {}
    }

    const next: Partial<AppState> = { ...surfacePatch }
    if (!groupUnchanged) {
      next.groupsByWorktree = {
        ...state.groupsByWorktree,
        [worktreeId]: groups.map((group) =>
          group.id === groupId ? { ...group, activeTabId: tabId } : group
        )
      }
    }
    if (!focusUnchanged) {
      next.activeGroupIdByWorktree = {
        ...state.activeGroupIdByWorktree,
        [worktreeId]: activeGroupId
      }
    }
    return next
  })
}

export function restoreTabDragActivationSnapshot(
  worktreeId: string,
  snapshot: TabDragActivationSnapshot
): void {
  useAppStore.setState((state): Partial<AppState> => {
    const groups = state.groupsByWorktree[worktreeId] ?? []
    const groupsUnchanged = groups.every(
      (group) => (snapshot.activeTabIdByGroup[group.id] ?? null) === group.activeTabId
    )
    const focusUnchanged =
      (state.activeGroupIdByWorktree[worktreeId] ?? null) === snapshot.activeGroupId

    const next: Partial<AppState> = {}
    if (!groupsUnchanged) {
      next.groupsByWorktree = {
        ...state.groupsByWorktree,
        [worktreeId]: groups.map((group) => ({
          ...group,
          activeTabId: snapshot.activeTabIdByGroup[group.id] ?? null
        }))
      }
    }
    if (!focusUnchanged) {
      if (snapshot.activeGroupId === null) {
        const nextActiveGroupIdByWorktree = { ...state.activeGroupIdByWorktree }
        delete nextActiveGroupIdByWorktree[worktreeId]
        next.activeGroupIdByWorktree = nextActiveGroupIdByWorktree
      } else {
        next.activeGroupIdByWorktree = {
          ...state.activeGroupIdByWorktree,
          [worktreeId]: snapshot.activeGroupId
        }
      }
    }

    const restoredGroupId = snapshot.activeGroupId
    if (restoredGroupId) {
      const restoredTabId = snapshot.activeTabIdByGroup[restoredGroupId] ?? null
      Object.assign(
        next,
        previewActiveSurfacePatch(state, worktreeId, restoredGroupId, restoredTabId)
      )
    }

    if (Object.keys(next).length === 0) {
      return {}
    }

    return next
  })
}

export function restoreSourceGroupActiveTabAfterCrossGroupDrop({
  worktreeId,
  snapshot,
  sourceGroupId,
  movedTabId
}: {
  worktreeId: string
  snapshot: TabDragActivationSnapshot
  sourceGroupId: string
  movedTabId: string
}): void {
  const preDragActiveTabId = snapshot.activeTabIdByGroup[sourceGroupId] ?? null
  // Why: dropUnifiedTab already picks the next active tab when the moved tab
  // was the source group's selection; only preview contamination needs undo.
  if (preDragActiveTabId === movedTabId) {
    return
  }

  useAppStore.setState((state): Partial<AppState> => {
    const groups = state.groupsByWorktree[worktreeId] ?? []
    const sourceGroup = groups.find((group) => group.id === sourceGroupId)
    if (!sourceGroup || sourceGroup.activeTabId === preDragActiveTabId) {
      return {}
    }
    return {
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [worktreeId]: groups.map((group) =>
          group.id === sourceGroupId ? { ...group, activeTabId: preDragActiveTabId } : group
        )
      }
    }
  })
}
