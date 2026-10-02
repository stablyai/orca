import { toast } from 'sonner'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import {
  createRecentlyClosedTabPositionIndex,
  pushRecentlyClosedTabKind,
  restoreRecentlyClosedTabPosition
} from '../../recently-closed-tabs'
import { notifyHostOfMirroredEditorClose } from '@/runtime/close-mirrored-editor-tab'
import { buildEditorActiveResult } from '../tabs/editor-open-target-group'
import { type ClosedEditorTabSnapshot, MAX_RECENT_CLOSED_EDITOR_TABS } from '../types/open-file'
import { deferRecoveredEditorDraft } from './parked-recovered-editor-drafts'
import { editorDocumentPathOwnerKey } from '../file-ids/editor-document-identity'
import { recoveredDraftBlockedMessage } from './recovered-draft-block-notice'
import { getReusableOpenFileModes, matchesEditorMode } from '../file-ids/editor-file-ids'
import {
  deleteUntouchedUntitledFile,
  shouldDeleteUntouchedUntitledFile
} from '../tabs/untitled-file-cleanup'

export function createRecentlyClosedEditorTabs(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'reopenClosedEditorTab' | 'closeAllFiles'> {
  return {
    reopenClosedEditorTab: (worktreeId) => {
      const stack = get().recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
      const next = stack[0]
      if (!next) {
        return false
      }
      set((s) => ({
        recentlyClosedEditorTabsByWorktree: {
          ...s.recentlyClosedEditorTabsByWorktree,
          [worktreeId]: (s.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []).slice(1)
        }
      }))
      const { position, reopenId, dirtyDraftContent, ...file } = next
      const collisionToast = (): void => {
        toast.info(recoveredDraftBlockedMessage('unsaved-rival', file))
      }
      const readOnlyCollisionToast = (): void => {
        toast.info(recoveredDraftBlockedMessage('read-only', file))
      }
      // Why both halves: setActiveFile promotes the record's unified tab inside its group, and the
      // open-target result raises the editor surface the normal open path would have raised.
      const activateLiveRecord = (liveFileId: string): void => {
        get().setActiveFile(liveFileId)
        set((s) => buildEditorActiveResult(s, file.worktreeId, liveFileId))
      }
      // Why only when the record has none: a snapshot baseline older than the live record's would
      // manufacture a conflict, but a dirty record with no baseline at all is unverifiable.
      const adoptSnapshotDiskBaseline = (liveFileId: string): void => {
        if (next.lastKnownDiskSignature === undefined) {
          return
        }
        const liveFile = get().openFiles.find((f) => f.id === liveFileId)
        if (!liveFile || liveFile.lastKnownDiskSignature !== undefined) {
          return
        }
        get().setLastKnownDiskSignature(liveFileId, next.lastKnownDiskSignature)
        get().setPendingDiskBaselineVerification(liveFileId, true)
      }
      if (dirtyDraftContent !== undefined) {
        // Why decided before the open: openFile would give the live record a second unified tab in
        // the snapshot's group, and the writes below would then land on the wrong document.
        const beforeCollisionCheck = get()
        // Why the surface-blind key: openFile's reuse rule ignores readOnly/liveTail, so a writable
        // snapshot whose identity key differs from a live read-only log still lands on that record.
        const identity = editorDocumentPathOwnerKey(file)
        const modes = getReusableOpenFileModes(file.mode)
        const matches = beforeCollisionCheck.openFiles.filter(
          (candidate) =>
            matchesEditorMode(candidate, modes) &&
            editorDocumentPathOwnerKey(candidate) === identity
        )
        // Why writable first: a read-only twin only blocks the draft when nothing writable can hold it.
        const live = matches.find((candidate) => candidate.readOnly !== true) ?? matches[0]
        const liveDraft = live ? beforeCollisionCheck.editorDrafts[live.id] : undefined
        if (live?.readOnly === true) {
          // Why no open: openFile would reuse this record and hang a second unified tab off the
          // snapshot's group, and a read-only record can hold neither the draft nor its baseline.
          set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
          activateLiveRecord(live.id)
          readOnlyCollisionToast()
          return true
        }
        if (live && liveDraft === dirtyDraftContent) {
          // Why nothing is written: the live record already holds this exact text, so the draft and
          // baseline writes would only replace a newer baseline with the snapshot's older one.
          adoptSnapshotDiskBaseline(live.id)
          activateLiveRecord(live.id)
          return true
        }
        if (live && (liveDraft !== undefined || live.isDirty === true)) {
          // Why deferred rather than dropped: the snapshot holds the only copy of that unsaved text.
          set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
          // Why activate: the toast names a document the user must act on, so show it to them.
          activateLiveRecord(live.id)
          collisionToast()
          return true
        }
      }
      // Why captured before the open: openFile's reuse rule is coarser than the identity key above
      // (it also reuses across local/WSL path aliases), so a collision can still surface here.
      // Why targetGroupId is still passed: only that alias case can reuse a live record here, and
      // the snapshot's own group is where the user closed it from.
      const beforeOpen = get()
      const reusableRecordIds = new Set(beforeOpen.openFiles.map((f) => f.id))
      const draftsBeforeOpen = beforeOpen.editorDrafts
      const dirtyBeforeOpen = new Set(
        beforeOpen.openFiles.filter((f) => f.isDirty === true).map((f) => f.id)
      )
      const restoredFileId = get().openFile(file, {
        targetGroupId: position?.groupId,
        reopenId
      })
      if (
        dirtyDraftContent !== undefined &&
        get().openFiles.find((f) => f.id === restoredFileId)?.readOnly === true
      ) {
        // Why: openFile's reuse rule ignores readOnly, and setEditorDraft/markFileDirty hard no-op
        // on a read-only record — writing the draft below would consume the snapshot and lose it.
        set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
        readOnlyCollisionToast()
        return true
      }
      const reusedLiveRecord = reusableRecordIds.has(restoredFileId)
      const reusedRecordHasUnsavedWork =
        reusedLiveRecord &&
        (draftsBeforeOpen[restoredFileId] !== undefined || dirtyBeforeOpen.has(restoredFileId))
      if (dirtyDraftContent !== undefined && reusedRecordHasUnsavedWork) {
        if (draftsBeforeOpen[restoredFileId] === dirtyDraftContent) {
          // Why nothing is written: the reused record already holds this exact text, so the draft
          // and baseline writes would only replace a newer baseline with the snapshot's older one.
          adoptSnapshotDiskBaseline(restoredFileId)
          return true
        }
        // Why put the snapshot back: its buffer has nowhere to restore to yet, and dropping it here
        // would destroy the only copy of that unsaved text.
        set((s) => deferRecoveredEditorDraft(s, worktreeId, next))
        collisionToast()
        return true
      }
      // Why: a live `OpenFile` has no dirtyDraftContent — only the hydration heal parks one on a
      // snapshot, for a record the restore could not give an id of its own. Reopen restores it.
      if (dirtyDraftContent !== undefined) {
        get().setEditorDraft(restoredFileId, dirtyDraftContent)
        get().markFileDirty(restoredFileId, true)
        // Why: the draft derives from the disk state this baseline was taken over, so the
        // restored-tab conflict scan must re-verify it before autosave resumes.
        if (next.lastKnownDiskSignature !== undefined) {
          get().setLastKnownDiskSignature(restoredFileId, next.lastKnownDiskSignature)
          get().setPendingDiskBaselineVerification(restoredFileId, true)
        }
      }
      restoreRecentlyClosedTabPosition(get, worktreeId, restoredFileId, position)
      return true
    },

    closeAllFiles: () => {
      const state = get()
      const activeWorktreeId = state.activeWorktreeId

      // Why: like closeFile — untitled unedited files are empty placeholders that shouldn't survive close-all.
      const untitledToDelete = state.openFiles.filter(
        (f) =>
          shouldDeleteUntouchedUntitledFile(f, !!state.editorDrafts[f.id]) &&
          (!activeWorktreeId || f.worktreeId === activeWorktreeId)
      )
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
        const shouldDeactivateWorktree =
          browserTabsForWorktree.length === 0 && terminalTabsForWorktree.length === 0

        // Why: mirrored tabs use host tab ids in tab order while local entries use file ids; remove both shapes.
        const closedFileIds = new Set(
          s.openFiles.filter((f) => f.worktreeId === activeWorktreeId).map((f) => f.id)
        )
        const closedTabOrderIds = new Set([...closedFileIds, ...closingItemIds])
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
          if (
            shouldDeleteUntouchedUntitledFile(f, !!s.editorDrafts[f.id]) ||
            f.mode === 'markdown-preview'
          ) {
            continue
          }
          const { id: _id, isDirty: _dirty, mirroredFromRuntimeSession: _mirrored, ...snap } = f
          const position = positionIndex.positionFor(f.id)
          nextRecentClosed = [
            {
              ...(snap as ClosedEditorTabSnapshot),
              reopenId: f.id,
              ...(position ? { position } : {})
            },
            ...nextRecentClosed
          ].slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
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
        const postCloseState = get()
        for (const f of untitledToDelete) {
          deleteUntouchedUntitledFile(postCloseState, f)
        }
      }
      for (const itemId of closingItemIds) {
        get().closeUnifiedTab?.(itemId)
      }
    }
  }
}
