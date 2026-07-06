import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TabStripSelectionState } from '@/components/tab-bar/tab-strip-selection'

export type TabStripSelectionSlice = {
  tabStripSelectionByWorktree: Record<string, TabStripSelectionState>
  setTabStripSelection: (
    worktreeId: string,
    selection:
      | TabStripSelectionState
      | ((current: TabStripSelectionState) => TabStripSelectionState)
  ) => void
  clearTabStripSelection: (worktreeId: string) => void
}

const EMPTY_TAB_STRIP_SELECTION: TabStripSelectionState = {
  selectedIds: [],
  anchorId: null,
  tabStripId: null
}

export function getEmptyTabStripSelection(): TabStripSelectionState {
  return EMPTY_TAB_STRIP_SELECTION
}

export const createTabStripSelectionSlice: StateCreator<
  AppState,
  [],
  [],
  TabStripSelectionSlice
> = (set, get) => ({
  tabStripSelectionByWorktree: {},
  setTabStripSelection: (worktreeId, selection) => {
    set((state) => {
      const current = state.tabStripSelectionByWorktree[worktreeId] ?? EMPTY_TAB_STRIP_SELECTION
      const next = typeof selection === 'function' ? selection(current) : selection
      if (next === current) {
        return state
      }
      if (next.selectedIds.length === 0 && next.anchorId === null) {
        if (!state.tabStripSelectionByWorktree[worktreeId]) {
          return state
        }
        const { [worktreeId]: _removed, ...rest } = state.tabStripSelectionByWorktree
        return { tabStripSelectionByWorktree: rest }
      }
      return {
        tabStripSelectionByWorktree: {
          ...state.tabStripSelectionByWorktree,
          [worktreeId]: next
        }
      }
    })
  },
  clearTabStripSelection: (worktreeId) => {
    if (!get().tabStripSelectionByWorktree[worktreeId]) {
      return
    }
    set((state) => {
      const { [worktreeId]: _removed, ...rest } = state.tabStripSelectionByWorktree
      return { tabStripSelectionByWorktree: rest }
    })
  }
})
