import type { StateCreator } from 'zustand'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  addWorkspaceGridViewMember,
  removeWorkspaceGridViewMember
} from '@/lib/workspace-grid-view-membership'
import type { AppState } from '../types'
import { selectFolderWorkspaces } from '../workspace-record-selectors'
import {
  loadWorkspaceGridViewMemberIds,
  saveWorkspaceGridViewMemberIds
} from './workspace-grid-view-storage'

export type WorkspaceGridViewSlice = {
  /** Workspaces shown together on the grid view, in cell order. Window presentation only: never
   *  sent to paired hosts or mobile clients. */
  workspaceGridViewMemberIds: readonly string[]
  addWorkspaceToGridView: (workspaceId: string) => void
  removeWorkspaceFromGridView: (workspaceId: string) => void
}

/** Whether a stored member still names a worktree or folder workspace this window knows. */
export function isKnownGridViewWorkspace(
  state: Pick<AppState, 'folderWorkspaces' | 'getKnownWorktreeById'>,
  workspaceId: string
): boolean {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return selectFolderWorkspaces(state).some((row) => row.id === scope.folderWorkspaceId)
  }
  return state.getKnownWorktreeById(workspaceId) !== undefined
}

export const createWorkspaceGridViewSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceGridViewSlice
> = (set, get) => {
  const commit = (next: readonly string[]): void => {
    if (next === get().workspaceGridViewMemberIds) {
      return
    }
    set({ workspaceGridViewMemberIds: next })
    saveWorkspaceGridViewMemberIds(next)
  }

  return {
    workspaceGridViewMemberIds: loadWorkspaceGridViewMemberIds(),

    addWorkspaceToGridView: (workspaceId) => {
      const state = get()
      commit(
        addWorkspaceGridViewMember(
          state.workspaceGridViewMemberIds,
          workspaceId,
          state.activeWorktreeId,
          (memberId) => isKnownGridViewWorkspace(state, memberId)
        )
      )
    },

    removeWorkspaceFromGridView: (workspaceId) => {
      commit(removeWorkspaceGridViewMember(get().workspaceGridViewMemberIds, workspaceId))
    }
  }
}
