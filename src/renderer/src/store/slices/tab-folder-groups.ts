import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TabFolderGroup } from '../../../../shared/tab-folder-types'
import {
  assignTabsToFolderGroup,
  findFolderGroupAndWorktree,
  nextTabFolderGroupColor,
  nextTabFolderGroupName,
  removeTabFromFolderGroup,
  ungroupFolderGroup,
  updateFolderGroup
} from '../../../../shared/tab-folder-group-state'
import { findTabAndWorktree } from './tab-group-state'
import { createBrowserUuid } from '@/lib/browser-uuid'

export type TabFolderGroupsSlice = {
  tabFolderGroupsByWorktree: Record<string, TabFolderGroup[]>
  renamingFolderGroupId: string | null
  createTabFolderGroup: (
    tabIds: string[],
    opts?: { name?: string; color?: string; collapsed?: boolean }
  ) => TabFolderGroup | null
  addTabsToFolderGroup: (
    folderGroupId: string,
    tabIds: string[],
    opts?: { index?: number }
  ) => boolean
  moveTabOutOfFolderGroup: (tabId: string) => boolean
  setTabFolderGroupName: (folderGroupId: string, name: string) => void
  setTabFolderGroupColor: (folderGroupId: string, color: string) => void
  setTabFolderGroupCollapsed: (folderGroupId: string, collapsed: boolean) => void
  ungroupTabFolderGroup: (folderGroupId: string) => void
  closeTabsInFolderGroup: (folderGroupId: string) => string[]
  setRenamingFolderGroupId: (folderGroupId: string | null) => void
}

export const createTabFolderGroupsSlice: StateCreator<AppState, [], [], TabFolderGroupsSlice> = (
  set,
  get
) => ({
  tabFolderGroupsByWorktree: {},
  renamingFolderGroupId: null,

  createTabFolderGroup: (tabIds, opts) => {
    const uniqueTabIds = [...new Set(tabIds)]
    const firstTab = uniqueTabIds
      .map((tabId) => findTabAndWorktree(get().unifiedTabsByWorktree, tabId))
      .find((found) => found !== null)
    if (!firstTab) {
      return null
    }
    const { worktreeId } = firstTab
    const splitGroupId = firstTab.tab.groupId
    const existing = get().tabFolderGroupsByWorktree[worktreeId] ?? []
    const folder: TabFolderGroup = {
      id: createBrowserUuid(),
      worktreeId,
      splitGroupId,
      name: opts?.name?.trim() || nextTabFolderGroupName(existing),
      color: opts?.color ?? nextTabFolderGroupColor(existing),
      collapsed: opts?.collapsed ?? false,
      tabOrder: [],
      sortOrder: existing.length,
      createdAt: Date.now()
    }
    let created: TabFolderGroup | null = null
    set((state) => {
      const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
      const assigned = assignTabsToFolderGroup(
        tabs,
        [...(state.tabFolderGroupsByWorktree[worktreeId] ?? []), folder],
        folder.id,
        uniqueTabIds
      )
      if (!assigned) {
        return {}
      }
      created = assigned.folders.find((candidate) => candidate.id === folder.id) ?? folder
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: assigned.tabs
        },
        tabFolderGroupsByWorktree: {
          ...state.tabFolderGroupsByWorktree,
          [worktreeId]: assigned.folders
        }
      }
    })
    return created
  },

  addTabsToFolderGroup: (folderGroupId, tabIds, opts) => {
    const found = findFolderGroupAndWorktree(get().tabFolderGroupsByWorktree, folderGroupId)
    if (!found) {
      return false
    }
    let added = false
    set((state) => {
      const assigned = assignTabsToFolderGroup(
        state.unifiedTabsByWorktree[found.worktreeId] ?? [],
        state.tabFolderGroupsByWorktree[found.worktreeId] ?? [],
        folderGroupId,
        tabIds,
        opts
      )
      if (!assigned) {
        return {}
      }
      added = true
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [found.worktreeId]: assigned.tabs
        },
        tabFolderGroupsByWorktree: {
          ...state.tabFolderGroupsByWorktree,
          [found.worktreeId]: assigned.folders
        }
      }
    })
    return added
  },

  moveTabOutOfFolderGroup: (tabId) => {
    const found = findTabAndWorktree(get().unifiedTabsByWorktree, tabId)
    if (!found) {
      return false
    }
    let removed = false
    set((state) => {
      const next = removeTabFromFolderGroup(
        state.unifiedTabsByWorktree[found.worktreeId] ?? [],
        state.tabFolderGroupsByWorktree[found.worktreeId] ?? [],
        tabId
      )
      if (!next) {
        return {}
      }
      removed = true
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [found.worktreeId]: next.tabs
        },
        tabFolderGroupsByWorktree: {
          ...state.tabFolderGroupsByWorktree,
          [found.worktreeId]: next.folders
        }
      }
    })
    return removed
  },

  setTabFolderGroupName: (folderGroupId, name) => {
    const trimmed = name.trim()
    if (!trimmed) {
      return
    }
    const found = findFolderGroupAndWorktree(get().tabFolderGroupsByWorktree, folderGroupId)
    if (!found) {
      return
    }
    set((state) => ({
      tabFolderGroupsByWorktree: {
        ...state.tabFolderGroupsByWorktree,
        [found.worktreeId]: updateFolderGroup(
          state.tabFolderGroupsByWorktree[found.worktreeId] ?? [],
          {
            ...found.folderGroup,
            name: trimmed
          }
        )
      }
    }))
  },

  setTabFolderGroupColor: (folderGroupId, color) => {
    const found = findFolderGroupAndWorktree(get().tabFolderGroupsByWorktree, folderGroupId)
    if (!found) {
      return
    }
    set((state) => ({
      tabFolderGroupsByWorktree: {
        ...state.tabFolderGroupsByWorktree,
        [found.worktreeId]: updateFolderGroup(
          state.tabFolderGroupsByWorktree[found.worktreeId] ?? [],
          {
            ...found.folderGroup,
            color
          }
        )
      }
    }))
  },

  setTabFolderGroupCollapsed: (folderGroupId, collapsed) => {
    const found = findFolderGroupAndWorktree(get().tabFolderGroupsByWorktree, folderGroupId)
    if (!found) {
      return
    }
    set((state) => ({
      tabFolderGroupsByWorktree: {
        ...state.tabFolderGroupsByWorktree,
        [found.worktreeId]: updateFolderGroup(
          state.tabFolderGroupsByWorktree[found.worktreeId] ?? [],
          {
            ...found.folderGroup,
            collapsed
          }
        )
      }
    }))
  },

  ungroupTabFolderGroup: (folderGroupId) => {
    const found = findFolderGroupAndWorktree(get().tabFolderGroupsByWorktree, folderGroupId)
    if (!found) {
      return
    }
    set((state) => {
      const next = ungroupFolderGroup(
        state.unifiedTabsByWorktree[found.worktreeId] ?? [],
        state.tabFolderGroupsByWorktree[found.worktreeId] ?? [],
        folderGroupId
      )
      if (!next) {
        return {}
      }
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [found.worktreeId]: next.tabs
        },
        tabFolderGroupsByWorktree: {
          ...state.tabFolderGroupsByWorktree,
          [found.worktreeId]: next.folders
        },
        renamingFolderGroupId:
          state.renamingFolderGroupId === folderGroupId ? null : state.renamingFolderGroupId
      }
    })
  },

  closeTabsInFolderGroup: (folderGroupId) => {
    const found = findFolderGroupAndWorktree(get().tabFolderGroupsByWorktree, folderGroupId)
    if (!found) {
      return []
    }
    const tabIds = [...found.folderGroup.tabOrder]
    for (const tabId of tabIds) {
      get().closeUnifiedTab(tabId)
    }
    return tabIds
  },

  setRenamingFolderGroupId: (folderGroupId) => {
    set({ renamingFolderGroupId: folderGroupId })
  }
})
