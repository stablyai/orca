import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import { isEditorTabContentType } from '../tabs/editor-tab-content-type'

export function createOpenFileMutations(
  set: EditorSet,
  get: EditorGet
): Pick<
  EditorSlice,
  | 'setActiveFile'
  | 'reorderFiles'
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
    setActiveFile: (fileId) => {
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        const worktreeId = file?.worktreeId
        return {
          activeFileId: fileId,
          activeFileIdByWorktree: worktreeId
            ? { ...s.activeFileIdByWorktree, [worktreeId]: fileId }
            : s.activeFileIdByWorktree
        }
      })
      const state = get()
      const worktreeId = state.activeWorktreeId
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

    reorderFiles: (fileIds) =>
      set((s) => {
        const reorderedSet = new Set(fileIds)
        const byId = new Map(s.openFiles.map((f) => [f.id, f]))
        const reordered = fileIds.map((id) => byId.get(id)).filter(Boolean) as OpenFile[]
        // Replace the reordered subset in-place: keep other-worktree files at their positions
        const result: OpenFile[] = []
        let ri = 0
        for (const f of s.openFiles) {
          if (reorderedSet.has(f.id)) {
            result.push(reordered[ri++])
          } else {
            result.push(f)
          }
        }
        return { openFiles: result }
      }),

    markFileDirty: (fileId, dirty) =>
      set((s) => {
        // Why: this fires on every keystroke; rebuilding openFiles unconditionally thrashes subscribers and caused typing lag, so bail when nothing changes.
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file) {
          return s
        }
        // Why: read-only tabs can never become dirty; hard no-op any stray change/save callback that reached here.
        if (file.readOnly === true) {
          return s
        }
        const needsPreviewClear = dirty && file.isPreview
        if (file.isDirty === dirty && !needsPreviewClear) {
          return s
        }
        const nextOpenFiles = s.openFiles.map((f) =>
          f.id === fileId
            ? { ...f, isDirty: dirty, ...(needsPreviewClear ? { isPreview: undefined } : {}) }
            : f
        )
        return {
          openFiles: nextOpenFiles,
          ...(needsPreviewClear
            ? {
                unifiedTabsByWorktree: Object.fromEntries(
                  Object.entries(s.unifiedTabsByWorktree ?? {}).map(([worktreeId, tabs]) => [
                    worktreeId,
                    tabs.map((tab) =>
                      tab.entityId === fileId && isEditorTabContentType(tab.contentType)
                        ? { ...tab, isPreview: false }
                        : tab
                    )
                  ])
                )
              }
            : {})
        }
      }),

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
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === fileId ? { ...f, externalMutation: next } : f
          )
        }
      }),

    setLastKnownDiskSignature: (fileId, signature) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file || file.lastKnownDiskSignature === signature) {
          return s
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === fileId ? { ...f, lastKnownDiskSignature: signature } : f
          )
        }
      }),

    clearPendingDiskBaselineVerification: (fileId) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file?.pendingDiskBaselineVerification) {
          return s
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === fileId ? { ...f, pendingDiskBaselineVerification: undefined } : f
          )
        }
      }),

    setPendingDiskBaselineVerification: (fileId, value) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        const next = value || undefined
        if (!file || file.pendingDiskBaselineVerification === next) {
          return s
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === fileId ? { ...f, pendingDiskBaselineVerification: next } : f
          )
        }
      }),

    setPendingLiveDiskVerification: (fileId, value) =>
      set((s) => {
        const file = s.openFiles.find((f) => f.id === fileId)
        const next = value || undefined
        if (!file || file.pendingLiveDiskVerification === next) {
          return s
        }
        return {
          openFiles: s.openFiles.map((f) =>
            f.id === fileId ? { ...f, pendingLiveDiskVerification: next } : f
          )
        }
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
