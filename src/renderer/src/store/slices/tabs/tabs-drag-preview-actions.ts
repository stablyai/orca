import {
  editSessionSource,
  type SessionSourceEdit,
  type OrdinarySourcePartial
} from '@/store/session-source-edits'
import type { AppState } from '../../types'
import type { TabsSlice, TabsSliceSet } from './tabs-slice-contract'

function previewActiveSurfacePatch(
  edit: SessionSourceEdit<AppState>,
  worktreeId: string,
  groupId: string,
  tabId: string | null
): OrdinarySourcePartial<AppState> {
  const state = edit.view()
  if (state.activeWorktreeId !== worktreeId || !tabId) {
    return {}
  }
  const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.id === tabId && tab.groupId === groupId
  )
  if (!unifiedTab) {
    return {}
  }

  if (unifiedTab.contentType === 'terminal') {
    if (
      state.activeTabType === 'terminal' &&
      state.activeTabTypeByWorktree[worktreeId] === 'terminal' &&
      state.activeTabId === unifiedTab.entityId &&
      state.activeTabIdByWorktree[worktreeId] === unifiedTab.entityId
    ) {
      return {}
    }
    edit.set('activeTabIdByWorktree', worktreeId, unifiedTab.entityId)
    edit.set('activeTabTypeByWorktree', worktreeId, 'terminal')
    return {
      activeTabId: unifiedTab.entityId,
      activeTabType: 'terminal'
    }
  }
  if (unifiedTab.contentType === 'browser') {
    if (
      state.activeTabType === 'browser' &&
      state.activeTabTypeByWorktree[worktreeId] === 'browser' &&
      state.activeBrowserTabId === unifiedTab.entityId &&
      state.activeBrowserTabIdByWorktree[worktreeId] === unifiedTab.entityId
    ) {
      return {}
    }
    edit.set('activeBrowserTabIdByWorktree', worktreeId, unifiedTab.entityId)
    edit.set('activeTabTypeByWorktree', worktreeId, 'browser')
    return {
      activeBrowserTabId: unifiedTab.entityId,
      activeTabType: 'browser'
    }
  }
  if (unifiedTab.contentType === 'simulator') {
    if (
      state.activeTabType === 'simulator' &&
      state.activeTabTypeByWorktree[worktreeId] === 'simulator'
    ) {
      return {}
    }
    edit.set('activeTabTypeByWorktree', worktreeId, 'simulator')
    return { activeTabType: 'simulator' }
  }
  if (
    state.activeTabType === 'editor' &&
    state.activeTabTypeByWorktree[worktreeId] === 'editor' &&
    state.activeFileId === unifiedTab.entityId &&
    state.activeFileIdByWorktree[worktreeId] === unifiedTab.entityId
  ) {
    return {}
  }
  edit.set('activeFileIdByWorktree', worktreeId, unifiedTab.entityId)
  edit.set('activeTabTypeByWorktree', worktreeId, 'editor')
  return {
    activeFileId: unifiedTab.entityId,
    activeTabType: 'editor'
  }
}

export function createTabsDragPreviewActions(
  set: TabsSliceSet
): Pick<
  TabsSlice,
  'previewDragActiveTab' | 'restoreDragActivationSnapshot' | 'restoreSourceGroupActiveTabAfterDrop'
> {
  return {
    previewDragActiveTab: ({ worktreeId, groupId, tabId, activeGroupId }) => {
      set((state) => {
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const targetGroup = groups.find((group) => group.id === groupId)
        const groupUnchanged = targetGroup?.activeTabId === tabId
        const focusUnchanged = (state.activeGroupIdByWorktree[worktreeId] ?? null) === activeGroupId
        const edit = editSessionSource(state)
        const surfacePatch = previewActiveSurfacePatch(edit, worktreeId, groupId, tabId)
        if (groupUnchanged && focusUnchanged) {
          return edit.changed || Object.keys(surfacePatch).length > 0
            ? edit.finish(surfacePatch)
            : undefined
        }

        if (!groupUnchanged) {
          edit.set(
            'groupsByWorktree',
            worktreeId,
            groups.map((group) => (group.id === groupId ? { ...group, activeTabId: tabId } : group))
          )
        }
        if (!focusUnchanged) {
          edit.set('activeGroupIdByWorktree', worktreeId, activeGroupId)
        }
        return edit.finish(surfacePatch)
      })
    },

    restoreDragActivationSnapshot: (worktreeId, snapshot) => {
      set((state) => {
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const groupsUnchanged = groups.every(
          (group) => (snapshot.activeTabIdByGroup[group.id] ?? null) === group.activeTabId
        )
        const focusUnchanged =
          (state.activeGroupIdByWorktree[worktreeId] ?? null) === snapshot.activeGroupId

        const edit = editSessionSource(state)
        let surfacePatch: OrdinarySourcePartial<AppState> = {}
        if (!groupsUnchanged) {
          edit.set(
            'groupsByWorktree',
            worktreeId,
            groups.map((group) => ({
              ...group,
              activeTabId: snapshot.activeTabIdByGroup[group.id] ?? null
            }))
          )
        }
        if (!focusUnchanged) {
          if (snapshot.activeGroupId === null) {
            edit.remove('activeGroupIdByWorktree', worktreeId)
          } else {
            edit.set('activeGroupIdByWorktree', worktreeId, snapshot.activeGroupId)
          }
        }

        const restoredGroupId = snapshot.activeGroupId
        if (restoredGroupId) {
          const restoredTabId = snapshot.activeTabIdByGroup[restoredGroupId] ?? null
          surfacePatch = previewActiveSurfacePatch(edit, worktreeId, restoredGroupId, restoredTabId)
        }

        if (!edit.changed && Object.keys(surfacePatch).length === 0) {
          return undefined
        }

        return edit.finish(surfacePatch)
      })
    },

    restoreSourceGroupActiveTabAfterDrop: ({ worktreeId, snapshot, sourceGroupId, movedTabId }) => {
      const preDragActiveTabId = snapshot.activeTabIdByGroup[sourceGroupId] ?? null
      // Why: dropUnifiedTab already picks the next active tab when the moved tab
      // was the source group's selection; only preview contamination needs undo.
      if (preDragActiveTabId === movedTabId) {
        return
      }

      set((state) => {
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const sourceGroup = groups.find((group) => group.id === sourceGroupId)
        if (!sourceGroup || sourceGroup.activeTabId === preDragActiveTabId) {
          return undefined
        }
        return editSessionSource(state)
          .set(
            'groupsByWorktree',
            worktreeId,
            groups.map((group) =>
              group.id === sourceGroupId ? { ...group, activeTabId: preDragActiveTabId } : group
            )
          )
          .finish({})
      })
    }
  }
}
