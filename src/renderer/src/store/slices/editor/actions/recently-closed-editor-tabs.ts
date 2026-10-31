import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import {
  createRecentlyClosedTabPositionIndex,
  pushRecentlyClosedTabKind,
  restoreRecentlyClosedTabPosition,
  takeClosedTabOrder
} from '../../recently-closed-tabs'
import { notifyHostOfMirroredEditorClose } from '@/runtime/close-mirrored-editor-tab'
import { type ClosedEditorTabSnapshot, type OpenFile } from '../types/open-file'
import { mayShareEditorBackingFile } from '../file-ids/editor-file-ids'
import {
  deleteUntouchedUntitledFile,
  shouldDeleteUntouchedUntitledFile
} from '../tabs/untitled-file-cleanup'
import { unifiedTabsKeepWorktreeSelected } from './unified-tabs-keep-worktree-selected'
import {
  placeClosedEditorSnapshot,
  rememberKeptUntitledEditor
} from './remember-kept-untitled-editor'
import { mapWithConcurrency } from '../../../../../../shared/map-with-concurrency'
import { isEditorTabContentType } from '../tabs/editor-tab-content-type'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import { afterPendingTabs, hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'
import type { AppState } from '../../../types'

// Why: files.stat waits up to 15s, but the runtime drops calls once 256 are
// pending. Four at a time still overlaps the slow checks without filling that queue.
const UNTITLED_CLOSE_STAT_CONCURRENCY = 4

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
      const { position, reopenId, closeOrder: _closeOrder, ...file } = next
      // Switch point: main opens a new tab at its old place in one command.
      const restoredFileId = get().openFile(file, {
        targetGroupId: position?.groupId,
        reopenId,
        ...(ORCA_LAYOUT_OWNER_IS_MAIN && position?.groupIndex !== undefined
          ? { groupIndex: position.groupIndex }
          : {})
      })
      restoreRecentlyClosedTabPosition(get, worktreeId, restoredFileId, position)
      return true
    },

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
      const untitledReopenPosition = new Map<
        string,
        ReturnType<ReturnType<typeof createRecentlyClosedTabPositionIndex>['positionFor']>
      >()
      for (const worktreeId of new Set(untitledToDelete.map((file) => file.worktreeId))) {
        if (!worktreeId) {
          continue
        }
        const positionIndex = createRecentlyClosedTabPositionIndex(state, worktreeId)
        for (const file of untitledToDelete) {
          if (file.worktreeId === worktreeId) {
            untitledReopenPosition.set(file.id, positionIndex.positionFor(file.id))
          }
        }
      }
      const closingFiles = state.openFiles.filter(
        (file) => !activeWorktreeId || file.worktreeId === activeWorktreeId
      )
      // Why: stamp in close order before any file stat, including notes we might keep after the check.
      const closeOrderByFileId = new Map<string, number>()
      for (const file of [...closingFiles].toReversed()) {
        if (file.mode === 'markdown-preview' || !file.worktreeId) {
          continue
        }
        closeOrderByFileId.set(file.id, takeClosedTabOrder())
      }
      // closeAll bypasses closeFile; notify removed mirrors’ hosts or next snapshot reopens them.
      for (const file of closingFiles) {
        notifyHostOfMirroredEditorClose(state, file.worktreeId, file.id)
      }

      const closingItemIds = Object.values(state.unifiedTabsByWorktree ?? {})
        .flat()
        .filter(
          (item) =>
            isEditorTabContentType(item.contentType) &&
            (!activeWorktreeId || item.worktreeId === activeWorktreeId)
        )
        .map((item) => item.id)
      // `recorded`: the store the reopen records are read from; `kept`: files a close left open.
      const cleanUp = (recorded: AppState | null, kept: ReadonlySet<string>): void => {
        set((s) => {
          const records = recorded ?? s
          if (!activeWorktreeId) {
            const keptOnly = <T>(record: Record<string, T>): Record<string, T> =>
              Object.fromEntries(Object.entries(record).filter(([id]) => kept.has(id)))
            return {
              openFiles: s.openFiles.filter((f) => kept.has(f.id)),
              editorDrafts: keptOnly(s.editorDrafts),
              editorCursorLine: keptOnly(s.editorCursorLine),
              activeFileId: null,
              activeTabType: 'terminal',
              markdownViewMode: keptOnly(s.markdownViewMode),
              markdownRichModeSizeOverride: keptOnly(s.markdownRichModeSizeOverride),
              editorViewMode: keptOnly(s.editorViewMode),
              markdownFrontmatterVisible: keptOnly(s.markdownFrontmatterVisible),
              markdownTableOfContentsVisible: keptOnly(s.markdownTableOfContentsVisible),
              pendingEditorReveal: null,
              pendingEditorFocusRequest: null
            }
          }
          const newFiles = s.openFiles.filter(
            (f) => f.worktreeId !== activeWorktreeId || kept.has(f.id)
          )
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

          const closingFiles = records.openFiles.filter(
            (f) => f.worktreeId === activeWorktreeId && !kept.has(f.id)
          )
          let nextRecentClosed = s.recentlyClosedEditorTabsByWorktree[activeWorktreeId] ?? []
          let nextRecentlyClosedKinds = s.recentlyClosedTabKindsByWorktree
          // Share one position index or per-file tab/group rescans make close-all cubic.
          const positionIndex = createRecentlyClosedTabPositionIndex(records, activeWorktreeId)
          for (const f of [...closingFiles].toReversed()) {
            // Skip deleted empty placeholders, ephemeral previews and chat visuals so undo retains useful paths only.
            if (f.mode === 'markdown-preview') {
              continue
            }
            const closeOrder = closeOrderByFileId.get(f.id)
            if (closeOrder === undefined || untitledIdsToDelete.has(f.id)) {
              continue
            }
            const { id: _id, isDirty: _dirty, mirroredFromRuntimeSession: _mirrored, ...snap } = f
            const position = positionIndex.positionFor(f.id)
            nextRecentClosed = placeClosedEditorSnapshot(nextRecentClosed, {
              ...(snap as ClosedEditorTabSnapshot),
              reopenId: f.id,
              closeOrder,
              ...(position ? { position } : {})
            })
            nextRecentlyClosedKinds = pushRecentlyClosedTabKind(
              nextRecentlyClosedKinds,
              activeWorktreeId,
              'editor',
              1,
              closeOrder
            )
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
            recentlyClosedTabKindsByWorktree: nextRecentlyClosedKinds
          }
        })
        if (typeof window !== 'undefined') {
          void (async () => {
            // A remote stat can take the full timeout, so the checks overlap. The
            // runtime rejects calls past its pending-request cap, and a rejected
            // check looks like a kept file. Stay under that cap.
            const files = [...untitledToDelete].toReversed().filter((file) => !kept.has(file.id))
            await mapWithConcurrency(files, UNTITLED_CLOSE_STAT_CONCURRENCY, async (file) => {
              const deleted = await deleteUntouchedUntitledFile(get, file)
              if (deleted) {
                return deleted
              }
              rememberKeptUntitledEditor(
                set,
                file,
                untitledReopenPosition.get(file.id),
                closeOrderByFileId.get(file.id) ?? takeClosedTabOrder()
              )
              return deleted
            })
          })()
        }
      }
      // Capture records before frames; drop content only after accepted closes, retaining files for refusals or pending reopen.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && closingItemIds.length > 0) {
        for (const itemId of closingItemIds) {
          get().closeUnifiedTab?.(itemId)
        }
        afterPendingTabs(closingItemIds, () => {
          const tabsNow = get().unifiedTabsByWorktree
          const kept = closingFiles.filter(
            (file) =>
              hasPendingEntityTab(file.worktreeId, file.id) ||
              (tabsNow[file.worktreeId] ?? []).some(
                (tab) => tab.entityId === file.id && isEditorTabContentType(tab.contentType)
              )
          )
          cleanUp(state, new Set(kept.map((file) => file.id)))
        })
        return
      }
      cleanUp(null, new Set())
      for (const itemId of closingItemIds) {
        get().closeUnifiedTab?.(itemId)
      }
    }
  }
}
