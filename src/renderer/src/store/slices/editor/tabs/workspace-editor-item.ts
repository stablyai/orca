import type { AppState } from '../../../types'
import type { EditorSlice } from '../types/editor-slice'
import type { EditorTabSelection, OpenFile } from '../types/open-file'
import { resolveEditorOpenTargetGroupId } from './editor-open-target-group'
import { areEditorPreviewTabsEnabled } from './editor-preview-tab-setting'
import { isEditorTabContentType, type EditorTabContentType } from './editor-tab-content-type'
import { getOpenFileExecutionHostId } from '@/lib/unified-tab-host-ownership'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import type { Tab } from '../../../../../../shared/tab-types'
import {
  openEditorTabThroughLayoutOwner,
  sendReusedEditorTabToLayoutOwner
} from './editor-tab-open-through-layout-owner'

export function openWorkspaceEditorItem(
  state: AppState,
  fileId: string,
  worktreeId: string,
  label: string,
  contentType: EditorTabContentType,
  isPreview?: boolean,
  targetGroupId?: string,
  selection: EditorTabSelection = 'focus',
  /** Where in its group a reopened tab goes back to. */
  index?: number
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
      // Switch point: an open that rewrote the tab's file record or view reaches main.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        sendReusedEditorTabToLayoutOwner(state, existing)
      }
      if (selection !== 'none') {
        // Why: sidebar preview reopens focus the tab without promoting it; explicit activation still promotes previews by default.
        state.activateTab?.(existing.id, {
          preservePreview: isPreview,
          ...(selection === 'background' ? { recordFocus: false } : {})
        })
      }
      return existing.id
    }
  }
  const drawHere = (id?: string): Tab | undefined => {
    const file =
      contentType === 'editor'
        ? state.openFiles.find((entry) => entry.id === fileId && entry.worktreeId === worktreeId)
        : undefined
    return state.createUnifiedTab?.(worktreeId, contentType, {
      ...(id ? { id } : {}),
      entityId: fileId,
      label,
      isPreview,
      // The tab follows the captured file owner even when another host has UI focus.
      ...(file ? { executionHostId: getOpenFileExecutionHostId(file) } : {}),
      ...(resolvedGroupId ? { targetGroupId: resolvedGroupId } : {}),
      ...(selection === 'none' ? { activate: false } : {}),
      ...(selection === 'background' ? { recordFocus: false } : {})
    })
  }
  // Switch point: main opens the tab under the window's proposed id and its frame draws it.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    const sent = openEditorTabThroughLayoutOwner(state, {
      fileId,
      worktreeId,
      contentType,
      isPreview: isPreview === true,
      groupId: resolvedGroupId,
      selection,
      index,
      drawHere
    })
    if (sent) {
      return sent
    }
  }
  return drawHere()?.id ?? fileId
}
export function getReplaceablePreviewFileId(
  state: Pick<AppState, 'openFiles' | 'unifiedTabsByWorktree' | 'settings'>,
  worktreeId: string,
  targetGroupId: string | undefined
): string | null {
  // Why: callers resolve intent first, but this helper is shared by five open paths — keep it correct for a caller that doesn't.
  if (!areEditorPreviewTabsEnabled(state)) {
    return null
  }
  const tabsForWorktree = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  if (targetGroupId) {
    const previewTab = tabsForWorktree.find(
      (tab) =>
        tab.groupId === targetGroupId && tab.isPreview && isEditorTabContentType(tab.contentType)
    )
    if (!previewTab) {
      return null
    }
    // Split groups share OpenFile records; scoped preview replacement must not mutate files still shown elsewhere.
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
