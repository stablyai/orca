import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { createNonSecureContextUuid } from '../../../../../../shared/non-secure-context-uuid'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import type { EditorGet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'

export function createProjectTextDraftActions(
  get: EditorGet
): Pick<EditorSlice, 'openNewProjectTextDraft' | 'restoreProjectTextDraftTabs'> {
  return {
    openNewProjectTextDraft: (groupId) => {
      const state = get()
      const worktreeId = state.activeWorktreeId
      const projectId = worktreeId ? state.getKnownWorktreeById(worktreeId)?.repoId : undefined
      if (!worktreeId || !projectId || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
        return
      }
      const names = new Set(
        state.openFiles
          .filter((file) => file.projectDraftProjectId === projectId)
          .map((file) => file.relativePath)
      )
      let number = 1
      while (names.has(`Untitled-${number}.txt`)) {
        number++
      }
      const fileId = state.openFile(
        {
          filePath: `orca-draft://${createNonSecureContextUuid()}`,
          relativePath: `Untitled-${number}.txt`,
          worktreeId,
          projectDraftProjectId: projectId,
          language: 'plaintext',
          isUntitled: true,
          mode: 'edit'
        },
        {
          targetGroupId: groupId,
          preview: false,
          focusEditor: true
        }
      )
      const primary = selectWorktreesByRepo(state)[projectId]?.find(
        (workspace) => workspace.isMainWorktree
      )
      const created = get().openFiles.find((file) => file.id === fileId)
      if (created && primary && primary.id !== worktreeId) {
        get().openFile(
          { ...created, worktreeId: primary.id, operationProvenance: undefined },
          {
            preview: false,
            selection: 'none'
          }
        )
      }
    },
    restoreProjectTextDraftTabs: (worktreeId) => {
      const state = get()
      const projectId = state.getKnownWorktreeById(worktreeId)?.repoId
      if (!projectId) {
        return
      }
      const tabFiles = new Set(
        (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.entityId)
      )
      const shownPaths = new Set(
        state.openFiles
          .filter((file) => file.worktreeId === worktreeId && tabFiles.has(file.id))
          .map((file) => file.filePath)
      )
      for (const file of state.openFiles) {
        if (file.projectDraftProjectId === projectId && !shownPaths.has(file.filePath)) {
          shownPaths.add(file.filePath)
          state.openFile(
            { ...file, worktreeId, operationProvenance: undefined },
            {
              preview: false,
              selection: 'background'
            }
          )
        }
      }
    }
  }
}
