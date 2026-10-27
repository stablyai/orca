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

function withoutKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  const next = { ...record }
  for (const key of keys) {
    delete next[key]
  }
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

    markFileDirty: (fileId, dirty, opts) => {
      const promoted: Tab[] = []
      set((s) => {
        // Per-keystroke openFiles rebuilds caused typing lag; preserve no-op identity.
        const file = s.openFiles.find((f) => f.id === fileId)
        if (!file) {
          return s
        }
        // Why: read-only tabs can never become dirty; hard no-op any stray change/save callback that reached here.
        if (
          (file.readOnly === true || file.csvPreviewOnly === true) &&
          (dirty || opts?.written !== true)
        ) {
          return s
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
          // Why every view: views of one record share one draft.
          ...(dropDraft
            ? { editorDrafts: withoutKeys(s.editorDrafts, editorBufferSiblingViewIds(s, fileId)) }
            : {}),
          ...(needsPreviewClear
            ? {
                unifiedTabsByWorktree: Object.fromEntries(
                  Object.entries(s.unifiedTabsByWorktree ?? {}).map(([worktreeId, tabs]) => [
                    worktreeId,
                    tabs.map((tab) =>
                      tab.entityId === fileId &&
                      isEditorTabContentType(tab.contentType) &&
                      // Switch point: main's frame ends a preview main owns.
                      endsPreviewHere(s, worktreeId)
                        ? withPreviewEnded(tab)
                        : tab
                    )
                  ])
                )
              }
            : {})
        }
      })
      // Switch point: main makes the edited preview tabs permanent.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && promoted.length > 0) {
        promotePreviewTabsThroughLayoutOwner(get(), set, promoted)
      }
    },

    setExternalMutation: (fileId, mutation) =>
      set((s) => updateEditorBuffer(s, fileId, { externalMutation: mutation ?? undefined })),

    setLastKnownDiskSignature: (fileId, signature) =>
      set((s) => updateEditorBuffer(s, fileId, { lastKnownDiskSignature: signature })),

    // Why: never touches readOnly, which also guards transcripts and keeps dirty drafts out of sessions.
    setTerminalArtifactGrant: (fileId, grantId) =>
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.id === fileId && f.terminalArtifactGrantId !== grantId
            ? { ...f, terminalArtifactGrantId: grantId }
            : f
        )
      })),

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
