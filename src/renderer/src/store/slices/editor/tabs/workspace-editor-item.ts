import type { AppState } from '../../../types'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import { resolveEditorOpenTargetGroupId } from './editor-open-target-group'
import { isEditorTabContentType } from './editor-tab-content-type'

type WorkspaceEditorItemOpen = {
  isPreview?: boolean
  /** Where to open; may already be retargeted to a parked preview's group. */
  targetGroupId?: string
  /** Group the caller pinned. Absent marks an unpinned open, free to reuse the entity's tab in any group. */
  pinnedGroupId?: string
}

export function openWorkspaceEditorItem(
  state: AppState,
  fileId: string,
  worktreeId: string,
  label: string,
  contentType: 'editor' | 'diff' | 'conflict-review' | 'check-details',
  open?: WorkspaceEditorItemOpen
): string {
  const { isPreview, targetGroupId, pinnedGroupId } = open ?? {}
  // Why: unpinned previews re-activate the entity's tab wherever it lives (#11839).
  if (isPreview && !pinnedGroupId) {
    const existingAnywhere = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (tab) => tab.entityId === fileId && tab.contentType === contentType
    )
    if (existingAnywhere) {
      state.activateTab?.(existingAnywhere.id, { preservePreview: isPreview })
      return existingAnywhere.id
    }
  }
  const resolvedGroupId = resolveEditorOpenTargetGroupId(state, worktreeId, targetGroupId)
  if (resolvedGroupId) {
    const existing = state.findTabForEntityInGroup?.(
      worktreeId,
      resolvedGroupId,
      fileId,
      contentType
    )
    if (existing) {
      // Why: sidebar preview reopens focus the tab without promoting it; explicit activation still promotes previews by default.
      state.activateTab?.(existing.id, { preservePreview: isPreview })
      return existing.id
    }
  }
  const created = state.createUnifiedTab?.(worktreeId, contentType, {
    entityId: fileId,
    label,
    isPreview,
    ...(resolvedGroupId ? { targetGroupId: resolvedGroupId } : {})
  })
  return created?.id ?? fileId
}

export type ReplaceablePreviewSlot = {
  /** Index into `openFiles` of the preview entry to overwrite in place. */
  index: number
  /** Group holding that preview; undefined when the caller pinned a target group. */
  retargetGroupId: string | undefined
}

// Why: unpinned preview reuse is worktree-scoped; pinned opens keep old group scoping.
export function resolveReplaceablePreviewSlot(
  state: Pick<AppState, 'openFiles' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  pinnedGroupId: string | undefined
): ReplaceablePreviewSlot | null {
  const tabsForWorktree = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const previewTab = tabsForWorktree.find(
    (tab) =>
      (!pinnedGroupId || tab.groupId === pinnedGroupId) &&
      tab.isPreview &&
      isEditorTabContentType(tab.contentType)
  )
  if (!previewTab) {
    // Why: without tab-layer state, only unpinned opens may fall back to the worktree preview.
    if (pinnedGroupId) {
      return null
    }
    const index = state.openFiles.findIndex(
      (file) => file.worktreeId === worktreeId && file.isPreview
    )
    return index === -1 ? null : { index, retargetGroupId: undefined }
  }
  // Why: split groups can share one OpenFile; replacing it would mutate it out from under another group's tab.
  const isSharedEntity = tabsForWorktree.some(
    (tab) =>
      tab.id !== previewTab.id &&
      tab.entityId === previewTab.entityId &&
      isEditorTabContentType(tab.contentType)
  )
  if (isSharedEntity) {
    return null
  }
  const index = state.openFiles.findIndex(
    (file) => file.id === previewTab.entityId && file.worktreeId === worktreeId && file.isPreview
  )
  if (index === -1) {
    return null
  }
  return { index, retargetGroupId: pinnedGroupId ? undefined : previewTab.groupId }
}

export function removeEditorStateForReplacedPreview(
  state: Pick<
    EditorSlice,
    | 'editorDrafts'
    | 'editorCursorLine'
    | 'markdownViewMode'
    | 'markdownRichModeSizeOverride'
    | 'editorViewMode'
    | 'markdownFrontmatterVisible'
    | 'markdownTableOfContentsVisible'
    | 'openFiles'
  >,
  replacedFile: Pick<OpenFile, 'id' | 'markdownPreviewSourceFileId'>,
  nextFileId: string
): Pick<
  EditorSlice,
  | 'editorDrafts'
  | 'editorCursorLine'
  | 'markdownViewMode'
  | 'markdownRichModeSizeOverride'
  | 'editorViewMode'
  | 'markdownFrontmatterVisible'
  | 'markdownTableOfContentsVisible'
> {
  const visibilityKeys = [
    replacedFile.id,
    ...(replacedFile.markdownPreviewSourceFileId ? [replacedFile.markdownPreviewSourceFileId] : [])
  ].filter(
    (key) =>
      key !== nextFileId &&
      !state.openFiles.some(
        (file) =>
          file.id !== replacedFile.id &&
          (file.id === key || file.markdownPreviewSourceFileId === key)
      )
  )
  if (replacedFile.id === nextFileId) {
    return {
      editorDrafts: state.editorDrafts,
      editorCursorLine: state.editorCursorLine,
      markdownViewMode: state.markdownViewMode,
      markdownRichModeSizeOverride: state.markdownRichModeSizeOverride,
      editorViewMode: state.editorViewMode,
      markdownFrontmatterVisible: state.markdownFrontmatterVisible,
      markdownTableOfContentsVisible: state.markdownTableOfContentsVisible
    }
  }
  return {
    editorDrafts: Object.fromEntries(
      Object.entries(state.editorDrafts).filter(([fileId]) => fileId !== replacedFile.id)
    ),
    editorCursorLine: Object.fromEntries(
      Object.entries(state.editorCursorLine).filter(([fileId]) => fileId !== replacedFile.id)
    ),
    markdownViewMode: Object.fromEntries(
      Object.entries(state.markdownViewMode).filter(([fileId]) => fileId !== replacedFile.id)
    ),
    markdownRichModeSizeOverride: Object.fromEntries(
      Object.entries(state.markdownRichModeSizeOverride).filter(
        ([fileId]) => fileId !== replacedFile.id
      )
    ),
    editorViewMode: Object.fromEntries(
      Object.entries(state.editorViewMode).filter(([fileId]) => fileId !== replacedFile.id)
    ),
    markdownFrontmatterVisible: removeMarkdownVisibilityKeys(
      state.markdownFrontmatterVisible,
      visibilityKeys
    ),
    markdownTableOfContentsVisible: removeMarkdownVisibilityKeys(
      state.markdownTableOfContentsVisible,
      visibilityKeys
    )
  }
}

export function removeMarkdownVisibilityKeys(
  visibility: Record<string, boolean>,
  keysToRemove: readonly string[]
): Record<string, boolean> {
  let next: Record<string, boolean> | null = null
  for (const key of keysToRemove) {
    if (!(key in visibility)) {
      continue
    }
    next ??= { ...visibility }
    delete next[key]
  }
  return next ?? visibility
}
