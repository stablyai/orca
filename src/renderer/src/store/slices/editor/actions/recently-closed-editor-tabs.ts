import { reopenRecoveredEditorTab } from './reopen-recovered-editor-tab'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import {
  createRecentlyClosedTabPositionIndex,
  pushRecentlyClosedTabKind
} from '../../recently-closed-tabs'
import { notifyHostOfMirroredEditorClose } from '@/runtime/close-mirrored-editor-tab'
import type { OpenFile } from '../types/open-file'
import { retainClosedEditorSnapshots } from './parked-recovered-editor-drafts'
import { mayShareEditorBackingFile } from '../file-ids/editor-file-ids'
import {
  deleteUntouchedUntitledFile,
  shouldDeleteUntouchedUntitledFile
} from '../tabs/untitled-file-cleanup'
import { unifiedTabsKeepWorktreeSelected } from './unified-tabs-keep-worktree-selected'

export function createRecentlyClosedEditorTabs(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'reopenClosedEditorTab' | 'closeAllFiles'> {
  return {
    reopenClosedEditorTab: (worktreeId) => reopenRecoveredEditorTab(set, get, worktreeId),

    closeAllFiles: () => {
      const state = get()
      const activeWorktreeId = state.activeWorktreeId

      const pendingFilesByPath = new Map<string, OpenFile[]>()
      for (const file of state.openFiles) {
        if (file.isDirty || file.id in state.editorDrafts) {
          const pendingFiles = pendingFilesByPath.get(file.filePath) ?? []
          pendingFiles.push(file)
          pendingFilesByPath.set(file.filePath, pendingFiles)
        }
      }
      // Why: like closeFile — untitled unedited files are empty placeholders that shouldn't survive close-all.
      const untitledToDelete = state.openFiles.filter(
        (f) =>
          shouldDeleteUntouchedUntitledFile(f, f.id in state.editorDrafts) &&
          (!activeWorktreeId || f.worktreeId === activeWorktreeId) &&
          !(pendingFilesByPath.get(f.filePath) ?? []).some((candidate) =>
            mayShareEditorBackingFile(candidate, f)
          )
      )
      const untitledIdsToDelete = new Set(untitledToDelete.map((file) => file.id))
      const closingFiles = state.openFiles.filter(
        (file) => !activeWorktreeId || file.worktreeId === activeWorktreeId
      )
      // Why: close-all bypasses closeFile, so notify mirrored host-owned editors here or the next host snapshot reopens them.
      for (const file of closingFiles) {
        notifyHostOfMirroredEditorClose(state, file.worktreeId, file.id)
      }

      const closingItemIds = Object.values(state.unifiedTabsByWorktree ?? {})
        .flat()
        .filter(
          (item) =>
            (item.contentType === 'editor' ||
              item.contentType === 'diff' ||
              item.contentType === 'conflict-review' ||
              item.contentType === 'check-details') &&
            (!activeWorktreeId || item.worktreeId === activeWorktreeId)
        )
        .map((item) => item.id)
      set((s) => {
        const activeWorktreeId = s.activeWorktreeId
        if (!activeWorktreeId) {
          return {
            openFiles: [],
            editorDrafts: {},
            editorCursorLine: {},
            activeFileId: null,
            activeTabType: 'terminal',
            markdownViewMode: {},
            markdownRichModeSizeOverride: {},
            editorViewMode: {},
            markdownFrontmatterVisible: {},
            markdownTableOfContentsVisible: {},
            pendingEditorReveal: null,
            pendingEditorFocusRequest: null
          }
        }
        // Only close files for the current worktree
        const newFiles = s.openFiles.filter((f) => f.worktreeId !== activeWorktreeId)
        const remainingFileIds = new Set(newFiles.map((f) => f.id))
        const newEditorDrafts = Object.fromEntries(
          Object.entries(s.editorDrafts).filter(([fileId]) => remainingFileIds.has(fileId))
        )
        const newMarkdownViewMode = Object.fromEntries(
          Object.entries(s.markdownViewMode).filter(([fileId]) => remainingFileIds.has(fileId))
        )
        const newMarkdownRichModeSizeOverride = Object.fromEntries(
          Object.entries(s.markdownRichModeSizeOverride).filter(([fileId]) =>
            remainingFileIds.has(fileId)
          )
        )
        const newEditorViewMode = Object.fromEntries(
          Object.entries(s.editorViewMode).filter(([fileId]) => remainingFileIds.has(fileId))
        )
        const newMarkdownFrontmatterVisible = Object.fromEntries(
          Object.entries(s.markdownFrontmatterVisible).filter(([fileId]) =>
            remainingFileIds.has(fileId)
          )
        )
        const newMarkdownTableOfContentsVisible = Object.fromEntries(
          Object.entries(s.markdownTableOfContentsVisible).filter(([fileId]) =>
            remainingFileIds.has(fileId)
          )
        )
        const newEditorCursorLine = Object.fromEntries(
          Object.entries(s.editorCursorLine).filter(([fileId]) => remainingFileIds.has(fileId))
        )
        const newActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        delete newActiveFileIdByWorktree[activeWorktreeId]
        const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        const browserTabsForWorktree = s.browserTabsByWorktree[activeWorktreeId] ?? []
        const terminalTabsForWorktree = s.tabsByWorktree[activeWorktreeId] ?? []
        newActiveTabTypeByWorktree[activeWorktreeId] =
          browserTabsForWorktree.length > 0 ? 'browser' : 'terminal'
        // Why: mirrored tabs use host tab ids in tab order while local entries use file ids; remove both shapes.
        const closedFileIds = new Set(
          s.openFiles.filter((f) => f.worktreeId === activeWorktreeId).map((f) => f.id)
        )
        const closedTabOrderIds = new Set([...closedFileIds, ...closingItemIds])
        const shouldDeactivateWorktree =
          browserTabsForWorktree.length === 0 &&
          terminalTabsForWorktree.length === 0 &&
          !unifiedTabsKeepWorktreeSelected(
            s.unifiedTabsByWorktree?.[activeWorktreeId],
            closedTabOrderIds
          )
        const nextTabBarOrderByWorktree = s.tabBarOrderByWorktree
          ? {
              ...s.tabBarOrderByWorktree,
              [activeWorktreeId]: (s.tabBarOrderByWorktree[activeWorktreeId] ?? []).filter(
                (entryId) => !closedTabOrderIds.has(entryId)
              )
            }
          : s.tabBarOrderByWorktree

        const closingFiles = s.openFiles.filter((f) => f.worktreeId === activeWorktreeId)
        let nextRecentClosed = s.recentlyClosedEditorTabsByWorktree[activeWorktreeId] ?? []
        let capturedCloseCount = 0
        // Why: one shared index — a per-file position lookup rescans tab order and group membership, making close-all cubic.
        const positionIndex = createRecentlyClosedTabPositionIndex(s, activeWorktreeId)
        for (const f of [...closingFiles].toReversed()) {
          // Why: skip untitled non-dirty files (deleted from disk after close) and ephemeral preview tabs so the reopen stack has no vanished/junk paths.
          if (untitledIdsToDelete.has(f.id) || f.mode === 'markdown-preview') {
            continue
          }
          const { id: _id, isDirty: _dirty, mirroredFromRuntimeSession: _mirrored, ...snap } = f
          const position = positionIndex.positionFor(f.id)
          nextRecentClosed = retainClosedEditorSnapshots([
            {
              ...snap,
              reopenId: f.id,
              ...(position ? { position } : {})
            },
            ...nextRecentClosed
          ])
          capturedCloseCount += 1
        }

        return {
          openFiles: newFiles,
          editorDrafts: newEditorDrafts,
          editorCursorLine: newEditorCursorLine,
          activeFileId: null,
          // Why: closing every editor can leave no renderable surface; clear the active worktree so the renderer shows the landing page, not a blank workspace.
          activeWorktreeId: shouldDeactivateWorktree ? null : s.activeWorktreeId,
          activeBrowserTabId: shouldDeactivateWorktree
            ? null
            : browserTabsForWorktree.length > 0
              ? (s.activeBrowserTabIdByWorktree[activeWorktreeId] ??
                browserTabsForWorktree[0]?.id ??
                null)
              : s.activeBrowserTabId,
          activeTabType: browserTabsForWorktree.length > 0 ? 'browser' : 'terminal',
          markdownViewMode: newMarkdownViewMode,
          markdownRichModeSizeOverride: newMarkdownRichModeSizeOverride,
          editorViewMode: newEditorViewMode,
          markdownFrontmatterVisible: newMarkdownFrontmatterVisible,
          markdownTableOfContentsVisible: newMarkdownTableOfContentsVisible,
          activeFileIdByWorktree: newActiveFileIdByWorktree,
          activeTabTypeByWorktree: newActiveTabTypeByWorktree,
          tabBarOrderByWorktree: nextTabBarOrderByWorktree,
          // Why: clear the one-shot search reveal; keeping it after closing all editors would make a later reopen jump to an old match.
          pendingEditorReveal: null,
          pendingEditorFocusRequest:
            s.pendingEditorFocusRequest?.worktreeId === activeWorktreeId
              ? null
              : s.pendingEditorFocusRequest,
          recentlyClosedEditorTabsByWorktree: {
            ...s.recentlyClosedEditorTabsByWorktree,
            [activeWorktreeId]: nextRecentClosed
          },
          recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
            s.recentlyClosedTabKindsByWorktree,
            activeWorktreeId,
            'editor',
            capturedCloseCount
          )
        }
      })
      if (typeof window !== 'undefined') {
        for (const f of untitledToDelete) {
          deleteUntouchedUntitledFile(get, f)
        }
      }
      for (const itemId of closingItemIds) {
        get().closeUnifiedTab?.(itemId)
      }
    }
  }
}
