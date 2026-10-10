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
import {
  deleteUntouchedUntitledFile,
  shouldDeleteUntouchedUntitledFile
} from '../tabs/untitled-file-cleanup'
import { unifiedTabsKeepWorktreeSelected } from './unified-tabs-keep-worktree-selected'
import { isSameEditorOwner, mayShareEditorBackingFile } from '../file-ids/editor-file-ids'

function isSameDocumentOwner(candidate: OpenFile, closedFile: OpenFile): boolean {
  const expectedRoute = closedFile.operationProvenance?.generation.route
  const actualRoute = candidate.operationProvenance?.generation.route
  return (
    isSameEditorOwner(candidate, closedFile.worktreeId, closedFile.runtimeEnvironmentId) &&
    candidate.filePath === closedFile.filePath &&
    candidate.externalSshTargetId === closedFile.externalSshTargetId &&
    actualRoute?.executionHostId === expectedRoute?.executionHostId &&
    actualRoute?.runtimeEnvironmentId === expectedRoute?.runtimeEnvironmentId
  )
}

function isSameOwnedDocument(candidate: OpenFile, closedFile: OpenFile): boolean {
  const expected = closedFile.operationProvenance
  const actual = candidate.operationProvenance
  const expectedGeneration = expected?.generation
  const actualGeneration = actual?.generation
  return (
    isSameDocumentOwner(candidate, closedFile) &&
    !closedFile.externalSshTargetId &&
    !candidate.externalSshTargetId &&
    actual?.ownershipProjection === expected?.ownershipProjection &&
    actual?.expectedSshConnectionGeneration === expected?.expectedSshConnectionGeneration &&
    actualGeneration?.runtimeConnectionGeneration ===
      expectedGeneration?.runtimeConnectionGeneration &&
    actualGeneration?.runtimePairingRevision === expectedGeneration?.runtimePairingRevision &&
    actualGeneration?.runtimeSshGeneration === expectedGeneration?.runtimeSshGeneration &&
    actualGeneration?.nestedSshGeneration === expectedGeneration?.nestedSshGeneration &&
    actualGeneration?.directSshGeneration === expectedGeneration?.directSshGeneration
  )
}

function findAdjacentOpenFileId(
  files: readonly OpenFile[],
  closedFileIds: ReadonlySet<string>,
  preferredFileId: string | null
): string | null {
  const preferredIndex = files.findIndex((file) => file.id === preferredFileId)
  const nextFile = files
    .slice(Math.max(preferredIndex + 1, 0))
    .find((file) => !closedFileIds.has(file.id))
  if (nextFile) {
    return nextFile.id
  }
  return (
    files
      .slice(0, Math.max(preferredIndex, 0))
      .toReversed()
      .find((file) => !closedFileIds.has(file.id))?.id ?? null
  )
}

export function createCloseFileAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'closeFile'> {
  return {
    closeFile: (fileId) => {
      // Why: capture untitled+dirty state before set() mutates the store, so cleanup of throwaway untitled files can decide after removal.
      const preClose = get().openFiles.find((f) => f.id === fileId)
      // Why: stale same-owner records survive tab close; retain other owners and pending drafts.
      const fileIdsToClose = new Set(
        preClose
          ? get()
              .openFiles.filter(
                (file) =>
                  file.id === fileId ||
                  (preClose.mode === 'edit' &&
                    file.mode === 'edit' &&
                    preClose.readOnly !== true &&
                    file.readOnly !== true &&
                    isSameOwnedDocument(file, preClose) &&
                    !file.isDirty &&
                    !(file.id in get().editorDrafts))
              )
              .map((file) => file.id)
          : [fileId]
      )
      const unifiedTabIdsToClose = Object.values(get().unifiedTabsByWorktree ?? {}).flatMap(
        (tabs) =>
          tabs
            .filter(
              (entry) =>
                fileIdsToClose.has(entry.entityId) &&
                (entry.contentType === 'editor' ||
                  entry.contentType === 'diff' ||
                  entry.contentType === 'conflict-review' ||
                  entry.contentType === 'check-details')
            )
            .map((entry) => entry.id)
      )
      const closedTabOrderIds = new Set([...fileIdsToClose, ...unifiedTabIdsToClose])
      const preCloseFiles = get().openFiles.filter((file) => fileIdsToClose.has(file.id))
      // Why: also check editorDrafts — isDirty is set by a debounced callback, so a draft can exist before isDirty flushes; a draft means the user typed something.
      const hasDraft = fileId in get().editorDrafts
      const shouldDeleteFromDisk =
        preClose !== undefined &&
        shouldDeleteUntouchedUntitledFile(preClose, hasDraft) &&
        !get().openFiles.some(
          (file) => !fileIdsToClose.has(file.id) && mayShareEditorBackingFile(file, preClose)
        )

      // Why: mirrored tabs are host-owned, so the host must close its copy or its next snapshot re-mirrors the file and the tab reopens.
      for (const file of preCloseFiles) {
        notifyHostOfMirroredEditorClose(get(), file.worktreeId, file.id)
      }

      set((s) => {
        const closedFile = s.openFiles.find((f) => f.id === fileId)
        const newFiles = s.openFiles.filter((f) => !fileIdsToClose.has(f.id))
        const newEditorDrafts = { ...s.editorDrafts }
        const newMarkdownViewMode = { ...s.markdownViewMode }
        const newMarkdownRichModeSizeOverride = { ...s.markdownRichModeSizeOverride }
        const newEditorViewMode = { ...s.editorViewMode }
        const newEditorCursorLine = { ...s.editorCursorLine }
        for (const id of fileIdsToClose) {
          delete newEditorDrafts[id]
          delete newMarkdownViewMode[id]
          delete newMarkdownRichModeSizeOverride[id]
          delete newEditorViewMode[id]
          // Why: editorCursorLine is keyed by fileId and grows unbounded across a long session without cleanup on close.
          delete newEditorCursorLine[id]
        }
        const markdownVisibilityKeys = new Set(fileIdsToClose)
        for (const file of preCloseFiles) {
          if (file.markdownPreviewSourceFileId) {
            markdownVisibilityKeys.add(file.markdownPreviewSourceFileId)
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

        if (s.activeFileId && fileIdsToClose.has(s.activeFileId)) {
          const worktreeId = closedFile?.worktreeId ?? s.activeWorktreeId
          const worktreeFiles = worktreeId
            ? s.openFiles.filter((file) => file.worktreeId === worktreeId)
            : s.openFiles
          newActiveId = findAdjacentOpenFileId(worktreeFiles, fileIdsToClose, s.activeFileId)
        }

        const closedWorktreeId = closedFile?.worktreeId
        if (closedWorktreeId) {
          const worktreeFiles = s.openFiles.filter((file) => file.worktreeId === closedWorktreeId)
          const worktreeActiveFileId = s.activeFileIdByWorktree[closedWorktreeId]
          if (worktreeActiveFileId && fileIdsToClose.has(worktreeActiveFileId)) {
            newActiveFileIdByWorktree[closedWorktreeId] = findAdjacentOpenFileId(
              worktreeFiles,
              fileIdsToClose,
              worktreeActiveFileId
            )
          } else if (s.activeFileId && fileIdsToClose.has(s.activeFileId)) {
            newActiveFileIdByWorktree[closedWorktreeId] = newActiveId
          }
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
        // Structured chats have no legacy terminal row to keep their workspace selected.
        const hasRemainingUnifiedTabs =
          activeWorktreeId !== null &&
          unifiedTabsKeepWorktreeSelected(
            s.unifiedTabsByWorktree?.[activeWorktreeId],
            fileIdsToClose
          )
        const shouldDeactivateWorktree =
          activeWorktreeId !== null &&
          remainingForWorktree.length === 0 &&
          browserTabsForWorktree.length === 0 &&
          terminalTabsForWorktree.length === 0 &&
          !hasRemainingUnifiedTabs

        // Why: prune the closed id from tabBarOrderByWorktree so stale ids don't shift positions on the next reconcile.
        const worktreeId = closedFile?.worktreeId ?? activeWorktreeId
        const nextTabBarOrderByWorktree =
          worktreeId && s.tabBarOrderByWorktree
            ? {
                ...s.tabBarOrderByWorktree,
                [worktreeId]: (s.tabBarOrderByWorktree[worktreeId] ?? []).filter(
                  (entryId) => !closedTabOrderIds.has(entryId)
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
            s.pendingEditorFocusRequest && fileIdsToClose.has(s.pendingEditorFocusRequest.fileId)
              ? null
              : s.pendingEditorFocusRequest,
          recentlyClosedEditorTabsByWorktree: nextRecentlyClosed,
          recentlyClosedTabKindsByWorktree: nextRecentlyClosedKinds
        }
      })

      // Why: untitled unedited files exist on disk only because createUntitledMarkdownFile() eagerly writes a bindable path; delete the clutter (fire-and-forget).
      if (shouldDeleteFromDisk && preClose && typeof window !== 'undefined') {
        deleteUntouchedUntitledFile(get, preClose)
      }

      // Why: route editor/diff closes through the unified close path (MRU + visual-neighbor fallback) so they match terminal/browser tab-close behavior.
      for (const unifiedTabId of unifiedTabIdsToClose) {
        get().closeUnifiedTab(unifiedTabId)
      }
    }
  }
}
