import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { isEditorTabContentType } from '../tabs/editor-tab-content-type'
import type { Tab } from '../../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { withPreviewEnded } from '../../tabs/tab-preview-flag'
import {
  previewEditorTabsOf,
  recordPromotedEditorTabsInLayoutOwner
} from '../tabs/editor-tab-layout-owner'
import { writeEditorBuffer } from '../buffers/editor-buffer-record'
import { getDiskBaselineSignature } from '../../../../../../shared/disk-baseline-signature'

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

export function createOpenFileMutations(
  set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  | 'setActiveFile'
  | 'markFileDirty'
  | 'setExternalMutation'
  | 'setLastKnownDiskSignature'
  | 'clearPendingDiskBaselineVerification'
  | 'setPendingDiskBaselineVerification'
  | 'setPendingLiveDiskVerification'
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
        // Why the scope guard: an overlay workspace (the floating panel) activates files while a
        // different workspace owns global selection; moving activeFileId would break the
        // agent-auto-ack invariant that the floating active tab never becomes global selection.
        const scopeWorktreeId = targetWorktreeId ?? worktreeId ?? s.activeWorktreeId
        return {
          ...(scopeWorktreeId === s.activeWorktreeId ? { activeFileId: fileId } : {}),
          activeFileIdByWorktree: worktreeId
            ? { ...s.activeFileIdByWorktree, [worktreeId]: fileId }
            : s.activeFileIdByWorktree
        }
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

    markFileDirty: (fileId, dirty) => {
      const promoted: Tab[] = []
      set((s) => {
        // Why: this fires on every keystroke; rebuilding openFiles unconditionally thrashes subscribers and caused typing lag, so bail when nothing changes.
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file) {
          return s
        }
        // Why: read-only tabs can never become dirty; hard no-op any stray change/save callback that reached here.
        if (file.readOnly === true || file.csvPreviewOnly === true) {
          return s
        }
        const needsPreviewClear = dirty && file.isPreview
        // Why: a clean tab holds no draft of the disk text; a kept one could later restore stale
        // text into a shared model. A draft that differs from disk (whitespace a Markdown view
        // does not count as an edit) is a real unsaved edit and stays.
        const draft = s.editorDrafts[fileId]
        const dropDraft =
          !dirty &&
          draft !== undefined &&
          (file.lastKnownDiskSignature === undefined ||
            getDiskBaselineSignature(draft) === file.lastKnownDiskSignature)
        if (file.isDirty === dirty && !needsPreviewClear && !dropDraft) {
          return s
        }
        if (ORCA_LAYOUT_OWNER_IS_MAIN && needsPreviewClear) {
          promoted.push(...previewEditorTabsOf(s.unifiedTabsByWorktree, fileId))
        }
        return {
          ...writeEditorBuffer(
            s,
            fileId,
            { isDirty: dirty },
            needsPreviewClear ? { isPreview: undefined } : undefined
          ),
          ...(dropDraft ? { editorDrafts: withoutKey(s.editorDrafts, fileId) } : {}),
          ...(needsPreviewClear
            ? {
                unifiedTabsByWorktree: Object.fromEntries(
                  Object.entries(s.unifiedTabsByWorktree ?? {}).map(([worktreeId, tabs]) => [
                    worktreeId,
                    tabs.map((tab) =>
                      tab.entityId === fileId && isEditorTabContentType(tab.contentType)
                        ? withPreviewEnded(tab)
                        : tab
                    )
                  ])
                )
              }
            : {})
        }
      })
      // Switch point: main records that an edit made a preview tab permanent.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && promoted.length > 0) {
        recordPromotedEditorTabsInLayoutOwner(get(), promoted)
      }
    },

    setExternalMutation: (fileId, mutation) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file) {
          return s
        }
        const next = mutation ?? undefined
        if (file.externalMutation === next) {
          return s
        }
        return writeEditorBuffer(s, fileId, { externalMutation: next })
      }),

    setLastKnownDiskSignature: (fileId, signature) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file || file.lastKnownDiskSignature === signature) {
          return s
        }
        return writeEditorBuffer(s, fileId, { lastKnownDiskSignature: signature })
      }),

    clearPendingDiskBaselineVerification: (fileId) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file?.pendingDiskBaselineVerification) {
          return s
        }
        return writeEditorBuffer(s, fileId, { pendingDiskBaselineVerification: undefined })
      }),

    setPendingDiskBaselineVerification: (fileId, value) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        const next = value || undefined
        if (!file || file.pendingDiskBaselineVerification === next) {
          return s
        }
        return writeEditorBuffer(s, fileId, { pendingDiskBaselineVerification: next })
      }),

    setPendingLiveDiskVerification: (fileId, value) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        const next = value || undefined
        if (!file || file.pendingLiveDiskVerification === next) {
          return s
        }
        return writeEditorBuffer(s, fileId, { pendingLiveDiskVerification: next })
      }),

    clearSelfMoveEcho: (fileId) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file?.pendingSelfMoveEcho) {
          return s
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === fileId ? { ...f, pendingSelfMoveEcho: undefined } : f
          )
        }
      }),
    clearUntitled: (fileId) =>
      set((s) => ({
        openFiles: s.openFiles.map((f) => (f.id === fileId ? { ...f, isUntitled: undefined } : f))
      }))
  }
}
