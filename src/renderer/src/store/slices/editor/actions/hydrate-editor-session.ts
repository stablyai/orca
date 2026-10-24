import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { buildValidWorktreeIdsForSessionHydration } from '../../../../../../shared/worktree/degraded-repo-worktree-validity'
import { migrateHydratedEditorTabsAndGroups } from '../file-ids/hydrated-editor-file-ids'
import { buildHydratedEditorSessionState } from './hydrated-editor-session-state'
import { selectFolderWorkspaces } from '../../../workspace-record-selectors'

export function createHydrateEditorSession(
  set: EditorSet,
  _get: EditorGet
): Pick<EditorSlice, 'hydrateEditorSession'> {
  return {
    hydrateEditorSession: (session, options) => {
      set((s) => {
        const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
          s,
          Object.keys(session.openFilesByWorktree ?? {})
        )
        validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
        for (const workspace of selectFolderWorkspaces(s)) {
          validWorktreeIds.add(folderWorkspaceKey(workspace.id))
        }
        addAdditionalValidWorkspaceKeys(validWorktreeIds, options)

        const { state, editorFileIdMigrationsByWorktree } = buildHydratedEditorSessionState(
          session,
          validWorktreeIds,
          // Why: use the store's activeWorktreeId — hydrateWorkspaceSession may have nulled an invalid ID, and we must respect that.
          s.activeWorktreeId
        )
        return {
          ...state,
          ...migrateHydratedEditorTabsAndGroups(s, editorFileIdMigrationsByWorktree)
        }
      })
    }
  }
}
