import { editSessionSource } from '@/store/session-source-edits'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { isEditorTabContentType } from '../tabs/editor-tab-content-type'
import type { Tab } from '../../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { withPreviewEnded } from '../../tabs/tab-preview-flag'
import { previewEditorTabsOf } from '../tabs/editor-tab-layout-owner'
import {
  endsPreviewHere,
  promotePreviewTabsThroughLayoutOwner
} from '../../tabs/preview-tab-promotion'
import {
  editorBufferOf,
  updateEditorBuffer,
  writeEditorBuffer
} from '../buffers/editor-buffer-record'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'
import { editorBufferSiblingViewIds } from '../buffers/editor-buffer-views'

export function createOpenFileMutations(
  set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  | 'setActiveFile'
  | 'markFileDirty'
  | 'setExternalMutation'
  | 'setLastKnownDiskSignature'
  | 'setTerminalArtifactGrant'
  | 'clearSelfMoveEcho'
  | 'clearUntitled'
> {
  return {
    setActiveFile: (fileId, targetWorktreeId) => {
      if (!get().openFiles.some((file) => file.id === fileId)) {
        return
      }
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        const worktreeId = file?.worktreeId
        // Floating/background activation stays workspace-local or violates agent-auto-ack’s global-selection invariant.
        const scopeWorktreeId = targetWorktreeId ?? worktreeId ?? s.activeWorktreeId
        const edit = editSessionSource(s)
        if (worktreeId) {
          edit.set('activeFileIdByWorktree', worktreeId, fileId)
        }
        return edit.finish(scopeWorktreeId === s.activeWorktreeId ? { activeFileId: fileId } : {})
      })
      const state = get()
      const worktreeId =
        targetWorktreeId ??
        state.openFiles.find((file) => file.id === fileId)?.worktreeId ??
        state.activeWorktreeId
      if (!worktreeId) {
        return
      }
      const groupId =
        state.activeGroupIdByWorktree?.[worktreeId] ?? state.groupsByWorktree?.[worktreeId]?.[0]?.id
      if (!groupId) {
        return
      }
      const item =
        state.findTabForEntityInGroup?.(worktreeId, groupId, fileId, 'editor') ??
        state.findTabForEntityInGroup?.(worktreeId, groupId, fileId, 'diff') ??
        state.findTabForEntityInGroup?.(worktreeId, groupId, fileId, 'conflict-review')
      if (item) {
        state.activateTab?.(item.id)
      }
    },

    markFileDirty: (fileId, dirty, opts) => {
      const promoted: Tab[] = []
      set((s) => {
        // Per-keystroke openFiles rebuilds caused typing lag; preserve no-op identity.
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file) {
          return undefined
        }
        // Why: read-only tabs can never become dirty; hard no-op any stray change/save callback that reached here.
        if (
          (file.readOnly === true || file.csvPreviewOnly === true) &&
          (dirty || opts?.written !== true)
        ) {
          return undefined
        }
        const buffer = editorBufferOf(s, file)
        const needsPreviewClear = dirty && file.isPreview
        // Clear disk-equal drafts from clean tabs or shared models can restore stale text; keep differing Markdown whitespace as real unsaved edits.
        const draft = s.editorDrafts[fileId]
        const dropDraft =
          !dirty &&
          draft !== undefined &&
          (buffer.lastKnownDiskSignature === undefined ||
            getDiskBaselineSignature(draft) === buffer.lastKnownDiskSignature)
        if (
          buffer.isDirty === dirty &&
          file.isDirty === dirty &&
          !needsPreviewClear &&
          !dropDraft
        ) {
          return undefined
        }
        if (ORCA_LAYOUT_OWNER_IS_MAIN && needsPreviewClear) {
          promoted.push(...previewEditorTabsOf(s.unifiedTabsByWorktree, fileId))
        }
        const edit = editSessionSource(s)
        const bufferPatch = writeEditorBuffer(
          edit,
          fileId,
          { isDirty: dirty },
          needsPreviewClear ? { isPreview: undefined } : undefined
        )
        if (dropDraft) {
          for (const id of editorBufferSiblingViewIds(s, fileId)) {
            edit.remove('editorDrafts', id)
          }
        }
        if (needsPreviewClear) {
          for (const [worktreeId, tabs] of Object.entries(s.unifiedTabsByWorktree ?? {})) {
            const next = tabs.map((tab) =>
              tab.entityId === fileId &&
              isEditorTabContentType(tab.contentType) &&
              endsPreviewHere(s, worktreeId)
                ? withPreviewEnded(tab)
                : tab
            )
            if (next.some((tab, index) => tab !== tabs[index])) {
              edit.set('unifiedTabsByWorktree', worktreeId, next)
            }
          }
        }
        return edit.finish(bufferPatch)
      })
      // Switch point: main makes the edited preview tabs permanent.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && promoted.length > 0) {
        promotePreviewTabsThroughLayoutOwner(get(), set, promoted)
      }
    },

    setExternalMutation: (fileId, mutation) =>
      set((s) => {
        const edit = editSessionSource(s)
        const patch = updateEditorBuffer(edit, fileId, { externalMutation: mutation ?? undefined })
        return patch ? edit.finish(patch) : undefined
      }),

    setLastKnownDiskSignature: (fileId, signature) =>
      set((s) => {
        const edit = editSessionSource(s)
        const patch = updateEditorBuffer(edit, fileId, { lastKnownDiskSignature: signature })
        return patch ? edit.finish(patch) : undefined
      }),

    // Why: never touches readOnly, which also guards transcripts and keeps dirty drafts out of sessions.
    setTerminalArtifactGrant: (fileId, grantId) =>
      set((s) => {
        const sourceEdit = editSessionSource(s)
        sourceEdit
          .sequence('openFiles')
          .map((f) =>
            f.id === fileId && f.terminalArtifactGrantId !== grantId
              ? { ...f, terminalArtifactGrantId: grantId }
              : f
          )
        return sourceEdit.finish({})
      }),

    clearSelfMoveEcho: (fileId) =>
      set((s) => {
        const sourceEdit = editSessionSource(s)

        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file?.pendingSelfMoveEcho) {
          return undefined
        }
        sourceEdit
          .sequence('openFiles')
          .map((f) => (f.id === fileId ? { ...f, pendingSelfMoveEcho: undefined } : f))
        return sourceEdit.finish({})
      }),
    clearUntitled: (fileId) =>
      set((s) => {
        const sourceEdit = editSessionSource(s)
        sourceEdit
          .sequence('openFiles')
          .map((f) => (f.id === fileId ? { ...f, isUntitled: undefined } : f))
        return sourceEdit.finish({})
      })
  }
}
