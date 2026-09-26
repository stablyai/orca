import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import { getRecentlyClosedTabPosition, pushRecentlyClosedTabKind } from '../../recently-closed-tabs'
import { notifyHostOfMirroredEditorClose } from '@/runtime/close-mirrored-editor-tab'
import {
  type ClosedEditorTabSnapshot,
  MAX_RECENT_CLOSED_EDITOR_TABS,
  type OpenFile
} from '../types/open-file'
import { removeMarkdownVisibilityKeys } from '../tabs/workspace-editor-item'
import { isEditorTabContentType } from '../tabs/editor-tab-content-type'
import { collectSameDocumentOpenFileIds } from '../file-ids/editor-file-ids'
import {
  deleteUntouchedUntitledFile,
  shouldDeleteUntouchedUntitledFile
} from '../tabs/untitled-file-cleanup'

export function createCloseFileAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'closeFile'> {
  return {
    closeFile: (fileId) => {
      // Why one snapshot: every read below describes the same pre-set() state, and closeFile runs
      // once per tab in the bulk-close loops, so a get() per candidate is paid N times over.
      const preCloseState = get()
      // Why: capture untitled+dirty state before set() mutates the store, so cleanup of throwaway untitled files can decide after removal.
      const preClose = preCloseState.openFiles.find((f) => f.id === fileId)

      // Why: also check editorDrafts — isDirty is set by a debounced callback, so a draft can exist before isDirty flushes; a draft means the user typed something.
      const hasUnsavedWork = (file: OpenFile): boolean =>
        file.isDirty === true || preCloseState.editorDrafts[file.id] !== undefined
      const documentFileIds = preClose
        ? collectSameDocumentOpenFileIds(preCloseState.openFiles, preClose)
        : new Set<string>()
      const documentFiles = preCloseState.openFiles.filter((file) => documentFileIds.has(file.id))
      // Why: a pinned tab survives every bulk close (see `isPinned` in shared/tab-types.ts), and the
      // sweep is a bulk close the user never aimed at that sibling — so pinning keeps it like a
      // rival draft does. The named id still closes even when pinned: that one was aimed at.
      const pinnedSiblingIds = new Set(
        preClose
          ? (preCloseState.unifiedTabsByWorktree?.[preClose.worktreeId] ?? [])
              .filter((tab) => tab.isPinned === true && isEditorTabContentType(tab.contentType))
              .map((tab) => tab.entityId)
          : []
      )
      // Why: duplicate records for one document each keep their own tab; closing one of them
      // leaves the rest to reopen the file, so a close takes the whole identity with it.
      // Why the unsaved filter: the caller's save/discard confirmation only asked about the named
      // id, so a duplicate holding its own unsaved buffer stays open rather than being discarded
      // silently — closing that one goes through the prompt on its own.
      const keptSiblingIds = new Set(
        documentFiles
          .filter(
            (file) => file.id !== fileId && (hasUnsavedWork(file) || pinnedSiblingIds.has(file.id))
          )
          .map((f) => f.id)
      )
      const siblingIds = new Set(
        documentFiles.length > 0
          ? documentFiles.filter((file) => !keptSiblingIds.has(file.id)).map((file) => file.id)
          : [fileId]
      )
      const sweptUnsavedWork = documentFiles.some(
        (file) => siblingIds.has(file.id) && hasUnsavedWork(file)
      )
      // Why the kept-sibling guard: a surviving duplicate still points at the untitled placeholder on disk.
      const shouldDeleteFromDisk =
        keptSiblingIds.size === 0 && shouldDeleteUntouchedUntitledFile(preClose, sweptUnsavedWork)

      // Why: mirrored tabs are host-owned, so the host must close its copy or its next snapshot re-mirrors the file and the tab reopens.
      // Why per sibling: the notifier resolves the mirror from the id it is given, so a mirrored duplicate swept under another id is never reported.
      notifyHostOfMirroredEditorClose(preCloseState, preClose?.worktreeId, fileId)
      for (const siblingId of siblingIds) {
        if (siblingId !== fileId) {
          notifyHostOfMirroredEditorClose(preCloseState, preClose?.worktreeId, siblingId)
        }
      }

      set((s) => {
        const closedFile = s.openFiles.find((f) => f.id === fileId)
        const newFiles = s.openFiles.filter((f) => !siblingIds.has(f.id))
        const newEditorDrafts = { ...s.editorDrafts }
        const newMarkdownViewMode = { ...s.markdownViewMode }
        const newMarkdownRichModeSizeOverride = { ...s.markdownRichModeSizeOverride }
        const newEditorViewMode = { ...s.editorViewMode }
        // Why: editorCursorLine is keyed by fileId and grows unbounded across a long session without cleanup on close.
        const newEditorCursorLine = { ...s.editorCursorLine }
        const markdownVisibilityKeys = new Set<string>()
        for (const siblingId of siblingIds) {
          delete newEditorDrafts[siblingId]
          delete newMarkdownViewMode[siblingId]
          delete newMarkdownRichModeSizeOverride[siblingId]
          delete newEditorViewMode[siblingId]
          delete newEditorCursorLine[siblingId]
          markdownVisibilityKeys.add(siblingId)
          const sourceFileId = s.openFiles.find(
            (f) => f.id === siblingId
          )?.markdownPreviewSourceFileId
          if (sourceFileId) {
            markdownVisibilityKeys.add(sourceFileId)
          }
        }
        const visibilityKeysToRemove = [...markdownVisibilityKeys].filter(
          (key) =>
            !newFiles.some((file) => file.id === key || file.markdownPreviewSourceFileId === key)
        )
        const newMarkdownFrontmatterVisible =
          visibilityKeysToRemove.length > 0
            ? removeMarkdownVisibilityKeys(s.markdownFrontmatterVisible, visibilityKeysToRemove)
            : s.markdownFrontmatterVisible
        const newMarkdownTableOfContentsVisible =
          visibilityKeysToRemove.length > 0
            ? removeMarkdownVisibilityKeys(s.markdownTableOfContentsVisible, visibilityKeysToRemove)
            : s.markdownTableOfContentsVisible
        let newActiveId = s.activeFileId
        const newActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        const activeWasClosed = s.activeFileId !== null && siblingIds.has(s.activeFileId)

        if (activeWasClosed) {
          // Find next file within the same worktree
          const worktreeId = closedFile?.worktreeId
          const preSweepFiles = worktreeId
            ? s.openFiles.filter((f) => f.worktreeId === worktreeId)
            : s.openFiles
          const worktreeFiles = worktreeId
            ? newFiles.filter((f) => f.worktreeId === worktreeId)
            : newFiles
          if (worktreeFiles.length === 0) {
            newActiveId = null
          } else {
            // Pick adjacent file from same worktree
            const closedPreSweepIdx = preSweepFiles.findIndex((f) => f.id === fileId)
            // Why counted over survivors: the raw pre-sweep index is shifted by every swept sibling
            // ahead of the closed file, which skips that many tabs in the post-sweep list.
            const closedWorktreeIdx =
              closedPreSweepIdx === -1
                ? worktreeFiles.length
                : preSweepFiles.slice(0, closedPreSweepIdx).filter((f) => !siblingIds.has(f.id))
                    .length
            newActiveId =
              closedWorktreeIdx >= worktreeFiles.length
                ? worktreeFiles.at(-1)!.id
                : worktreeFiles[closedWorktreeIdx].id
          }
          if (worktreeId) {
            newActiveFileIdByWorktree[worktreeId] = newActiveId
          }
        }
        // Why: a swept sibling must not stay named as some workspace's active file.
        const reselectedWorktreeId = activeWasClosed ? closedFile?.worktreeId : undefined
        for (const [wId, activeId] of Object.entries(newActiveFileIdByWorktree)) {
          if (wId === reselectedWorktreeId || !activeId || !siblingIds.has(activeId)) {
            continue
          }
          newActiveFileIdByWorktree[wId] = newFiles.find((f) => f.worktreeId === wId)?.id ?? null
        }

        // Why: editors share a mixed tab strip with browser tabs; closing the last editor should reveal a browser tab before falling back to a terminal.
        const activeWorktreeId = s.activeWorktreeId
        const remainingForWorktree = activeWorktreeId
          ? newFiles.filter((f) => f.worktreeId === activeWorktreeId)
          : newFiles
        const browserTabsForWorktree = activeWorktreeId
          ? (s.browserTabsByWorktree[activeWorktreeId] ?? [])
          : []
        const terminalTabsForWorktree = activeWorktreeId
          ? (s.tabsByWorktree[activeWorktreeId] ?? [])
          : []
        const fallbackBrowserTabId =
          activeWorktreeId && browserTabsForWorktree.length > 0
            ? (s.activeBrowserTabIdByWorktree[activeWorktreeId] ??
              browserTabsForWorktree[0]?.id ??
              null)
            : s.activeBrowserTabId
        const newActiveTabType =
          remainingForWorktree.length > 0
            ? s.activeTabType
            : browserTabsForWorktree.length > 0
              ? 'browser'
              : 'terminal'
        const newActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        if (activeWorktreeId && remainingForWorktree.length === 0) {
          newActiveTabTypeByWorktree[activeWorktreeId] =
            browserTabsForWorktree.length > 0 ? 'browser' : 'terminal'
        }
        const shouldDeactivateWorktree =
          activeWorktreeId !== null &&
          remainingForWorktree.length === 0 &&
          browserTabsForWorktree.length === 0 &&
          terminalTabsForWorktree.length === 0

        // Why: prune the closed id from tabBarOrderByWorktree so stale ids don't shift positions on the next reconcile.
        const worktreeId = closedFile?.worktreeId ?? activeWorktreeId
        const nextTabBarOrderByWorktree =
          worktreeId && s.tabBarOrderByWorktree
            ? {
                ...s.tabBarOrderByWorktree,
                [worktreeId]: (s.tabBarOrderByWorktree[worktreeId] ?? []).filter(
                  (entryId) => !siblingIds.has(entryId)
                )
              }
            : s.tabBarOrderByWorktree

        let nextRecentlyClosed = s.recentlyClosedEditorTabsByWorktree
        let nextRecentlyClosedKinds = s.recentlyClosedTabKindsByWorktree
        const wtRecent = closedFile?.worktreeId
        // Why: exclude untitled unedited files (deleted from disk after close, so Cmd+Shift+T can't reopen a gone path) and ephemeral preview tabs from the reopen stack.
        if (
          closedFile &&
          wtRecent &&
          !shouldDeleteFromDisk &&
          closedFile.mode !== 'markdown-preview'
        ) {
          const {
            id: _id,
            isDirty: _dirty,
            mirroredFromRuntimeSession: _mirrored,
            ...snap
          } = closedFile
          const stack = s.recentlyClosedEditorTabsByWorktree[wtRecent] ?? []
          const position = getRecentlyClosedTabPosition(s, wtRecent, fileId)
          nextRecentlyClosed = {
            ...s.recentlyClosedEditorTabsByWorktree,
            [wtRecent]: [
              {
                ...(snap as ClosedEditorTabSnapshot),
                reopenId: fileId,
                ...(position ? { position } : {})
              },
              ...stack
            ].slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
          }
          nextRecentlyClosedKinds = pushRecentlyClosedTabKind(
            s.recentlyClosedTabKindsByWorktree,
            wtRecent,
            'editor'
          )
        }

        return {
          openFiles: newFiles,
          editorDrafts: newEditorDrafts,
          editorCursorLine: newEditorCursorLine,
          activeFileId: newActiveId,
          // Why: if the last editor closes with no browser/terminal surface left, return to the landing state like the terminal/browser close handlers do.
          activeWorktreeId: shouldDeactivateWorktree ? null : s.activeWorktreeId,
          activeBrowserTabId: shouldDeactivateWorktree
            ? null
            : activeWorktreeId && remainingForWorktree.length === 0
              ? fallbackBrowserTabId
              : s.activeBrowserTabId,
          activeTabType: newActiveTabType,
          activeFileIdByWorktree: newActiveFileIdByWorktree,
          activeTabTypeByWorktree: newActiveTabTypeByWorktree,
          markdownViewMode: newMarkdownViewMode,
          markdownRichModeSizeOverride: newMarkdownRichModeSizeOverride,
          editorViewMode: newEditorViewMode,
          markdownFrontmatterVisible: newMarkdownFrontmatterVisible,
          markdownTableOfContentsVisible: newMarkdownTableOfContentsVisible,
          tabBarOrderByWorktree: nextTabBarOrderByWorktree,
          pendingEditorReveal: null,
          pendingEditorFocusRequest:
            s.pendingEditorFocusRequest && siblingIds.has(s.pendingEditorFocusRequest.fileId)
              ? null
              : s.pendingEditorFocusRequest,
          recentlyClosedEditorTabsByWorktree: nextRecentlyClosed,
          recentlyClosedTabKindsByWorktree: nextRecentlyClosedKinds
        }
      })

      // Why: untitled unedited files exist on disk only because createUntitledMarkdownFile() eagerly writes a bindable path; delete the clutter (fire-and-forget).
      if (shouldDeleteFromDisk && preClose && typeof window !== 'undefined') {
        deleteUntouchedUntitledFile(get(), preClose)
      }

      // Why: route editor/diff closes through the unified close path (MRU + visual-neighbor fallback) so they match terminal/browser tab-close behavior.
      // Why collected first: each close rewrites the tab maps this scan would otherwise be reading.
      // Why scoped: every swept record shares preClose's worktree and an editor tab is filed under
      // its file's worktree, so the other worktrees cost a pass per close and can only contribute a
      // foreign tab that happens to reuse the id.
      const tabsByWorktree = get().unifiedTabsByWorktree ?? {}
      const scannedTabLists = preClose
        ? [tabsByWorktree[preClose.worktreeId] ?? []]
        : Object.values(tabsByWorktree)
      const closableTabIds = scannedTabLists.flatMap((tabs) =>
        tabs
          .filter(
            (entry) => siblingIds.has(entry.entityId) && isEditorTabContentType(entry.contentType)
          )
          .map((entry) => entry.id)
      )
      for (const tabId of closableTabIds) {
        get().closeUnifiedTab(tabId)
      }
    }
  }
}
