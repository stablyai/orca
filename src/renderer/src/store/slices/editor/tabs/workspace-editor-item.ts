import type { AppState } from '../../../types'
import type { EditorSlice } from '../types/editor-slice'
import type { OpenFile } from '../types/open-file'
import { resolveEditorOpenTargetGroupId } from './editor-open-target-group'
import { isEditorTabContentType } from './editor-tab-content-type'

export function openWorkspaceEditorItem(
  state: AppState,
  fileId: string,
  worktreeId: string,
  label: string,
  contentType: 'editor' | 'diff' | 'conflict-review' | 'check-details',
  isPreview?: boolean,
  targetGroupId?: string
): string {
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
export function getReplaceablePreviewFileId(
  state: Pick<AppState, 'openFiles' | 'unifiedTabsByWorktree'>,
  worktreeId: string,
  targetGroupId: string | undefined
): string | null {
  const tabsForWorktree = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  if (targetGroupId) {
    const previewTab = tabsForWorktree.find(
      (tab) =>
        tab.groupId === targetGroupId && tab.isPreview && isEditorTabContentType(tab.contentType)
    )
    if (!previewTab) {
      return null
    }
    // Why: split groups can share one OpenFile; a group-scoped preview replacement must not mutate it out from under another group's tab.
    const isSharedEntity = tabsForWorktree.some(
      (tab) =>
        tab.id !== previewTab.id &&
        tab.entityId === previewTab.entityId &&
        isEditorTabContentType(tab.contentType)
    )
    if (isSharedEntity) {
      return null
    }
    return (
      state.openFiles.find(
        (file) =>
          file.id === previewTab.entityId && file.worktreeId === worktreeId && file.isPreview
      )?.id ?? null
    )
  }
  return (
    state.openFiles.find((file) => file.worktreeId === worktreeId && file.isPreview)?.id ?? null
  )
}

export function removeEditorStateForReplacedPreview(
  state: Pick<
    EditorSlice,
    | 'editorDrafts'
    | 'editorCursorLine'
    | 'markdownViewMode'
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
