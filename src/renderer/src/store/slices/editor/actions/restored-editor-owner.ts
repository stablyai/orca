import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { RestoredEditorOwnerResult } from '../types/restored-editor-owner'
import { buildRestoredEditorOwnerTransition } from './restored-editor-owner-transition'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { recordRestoredEditorMoveInLayoutOwner } from '../tabs/editor-tab-layout-owner'
import { writeEditorBuffer } from '../buffers/editor-buffer-record'

export function createRestoredEditorOwner(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'setRestoredEditorOwnerMigrationPending' | 'reparentRestoredEditorFileOwner'> {
  return {
    setRestoredEditorOwnerMigrationPending: (fileId, pending) => {
      let changed = false
      set((s) => {
        const file = s.openFiles.find((candidate) => candidate.id === fileId)
        const next = pending || undefined
        if (!file || file.pendingOwnerMigration === next) {
          return s
        }
        changed = true
        return writeEditorBuffer(s, fileId, { pendingOwnerMigration: next })
      })
      return changed
    },

    reparentRestoredEditorFileOwner: (args) => {
      const before = ORCA_LAYOUT_OWNER_IS_MAIN ? get() : null
      let result: RestoredEditorOwnerResult = { ok: false, reason: 'stale' }
      const projectReparent = buildRestoredEditorOwnerTransition(args, (next) => {
        result = next
      })
      const initialSource = get().openFiles.find((file) => file.id === args.fileId)
      const activatesTargetWorkspace = Boolean(
        initialSource &&
        get().activeWorktreeId === initialSource.worktreeId &&
        get().activeFileId === initialSource.id
      )
      if (activatesTargetWorkspace) {
        get().setActiveWorktree(args.targetWorktreeId, args.targetExecutionHostId, {
          stateTransition: projectReparent
        })
      } else {
        set((state) => projectReparent(state).patch)
      }
      if (ORCA_LAYOUT_OWNER_IS_MAIN && before && initialSource) {
        recordRestoredEditorMoveInLayoutOwner(before, get(), initialSource, result)
      }
      return result
    }
  }
}
