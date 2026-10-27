import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import {
  conflictOverviewView,
  conflictOverviewViewsKey
} from '@/store/slices/editor/buffers/editor-buffer-conflict-overview'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { isReloadableSingleFileDiffTab } from './editor-panel-diff-reload'
import type { EditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'
import type { EditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'
import { useQuickOpenHistoryVisit } from './use-quick-open-history-visit'

// Showing a tab is a user act: its first load may start a stopped WSL distro. Re-runs from
// polls (git status, overview views) are not, so they read without waking.
const ACTIVE_TAB_LOAD = { wakeWslDistro: true }

type GitStatusByWorktree = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree']

type UseEditorPanelActiveTabContentLoadParams = {
  activeFile: OpenFile | null
  selectedConflictReviewFile: OpenFile | null
  isVisible: boolean
  isChangesMode: boolean
  gitStatusEntries: GitStatusByWorktree[string] | undefined
  fileContents: Record<string, FileContent>
  diffContents: Record<string, DiffContent>
  fileReadGenerationRef: MutableRefObject<Record<string, number>>
  outstandingFileReadsRef: MutableRefObject<Record<string, number>>
  diffReadGenerationRef: MutableRefObject<Record<string, number>>
  outstandingDiffReadsRef: MutableRefObject<Record<string, number>>
  loadFileContent: EditorPanelFileContentLoader
  loadDiffContent: EditorPanelDiffContentLoader
}

// Reuse live reads across visibility changes; invalidation generations distinguish superseded reads.
function hasLiveRead(
  generationsById: Record<string, number>,
  outstandingById: Record<string, number>,
  id: string
): boolean {
  const generation = generationsById[id]
  return generation !== undefined && outstandingById[id] === generation
}

export function useEditorPanelActiveTabContentLoad({
  activeFile,
  selectedConflictReviewFile,
  isVisible,
  isChangesMode,
  gitStatusEntries,
  fileContents,
  diffContents,
  fileReadGenerationRef,
  outstandingFileReadsRef,
  diffReadGenerationRef,
  outstandingDiffReadsRef,
  loadFileContent,
  loadDiffContent
}: UseEditorPanelActiveTabContentLoadParams): void {
  useQuickOpenHistoryVisit(
    activeFile,
    activeFile ? fileContents[activeFile.id] : undefined,
    isVisible
  )
  // Why: an overview file's view can open, close, re-key or rejoin anywhere; reload under its new id.
  const overviewPaths = useMemo(
    () =>
      activeFile?.mode === 'conflict-review' && !selectedConflictReviewFile
        ? (activeFile.conflictReview?.entries ?? []).map((entry) =>
            joinPath(activeFile.filePath, entry.path)
          )
        : [],
    [activeFile, selectedConflictReviewFile]
  )
  const overviewWorktreeId = activeFile?.worktreeId ?? ''
  const overviewViewsKey = useAppStore((state) =>
    overviewPaths.length === 0
      ? ''
      : conflictOverviewViewsKey(state, overviewWorktreeId, overviewPaths)
  )
  const needsFileRead = (fileId: string): boolean => {
    const cached = fileContents[fileId]
    return (
      (!cached || cached.isStale === true) &&
      !hasLiveRead(fileReadGenerationRef.current, outstandingFileReadsRef.current, fileId)
    )
  }
  const needsDiffRead = (fileId: string): boolean => {
    const cached = diffContents[fileId]
    return (
      (!cached || cached.isStale === true) &&
      !hasLiveRead(diffReadGenerationRef.current, outstandingDiffReadsRef.current, fileId)
    )
  }

  const wokenTabIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isVisible) {
      return
    }
    const tabId = selectedConflictReviewFile?.id ?? activeFile?.id ?? null
    const load = tabId !== wokenTabIdRef.current ? ACTIVE_TAB_LOAD : undefined
    wokenTabIdRef.current = tabId
    if (activeFile?.mode === 'conflict-review' && !selectedConflictReviewFile) {
      const snapshotEntries = activeFile.conflictReview?.entries ?? []
      if (snapshotEntries.length === 0) {
        return
      }

      const snapshotPaths = new Set(snapshotEntries.map((entry) => entry.path))
      const liveEntries = gitStatusEntries ?? []
      for (const entry of liveEntries) {
        if (
          !snapshotPaths.has(entry.path) ||
          entry.conflictStatus !== 'unresolved' ||
          !entry.conflictKind ||
          entry.status === 'deleted'
        ) {
          continue
        }

        const absolutePath = joinPath(activeFile.filePath, entry.path)
        const view = conflictOverviewView(
          useAppStore.getState(),
          activeFile.worktreeId,
          absolutePath
        )
        // Why the view's own owner: another workspace's view must load as it would, never re-owned.
        if (view ? needsFileRead(view.id) : needsFileRead(absolutePath)) {
          void (view
            ? loadFileContent(view.filePath, view.id, view.worktreeId, view.relativePath, load)
            : loadFileContent(absolutePath, absolutePath, activeFile.worktreeId, entry.path, load))
        }
      }
      return
    }

    const fileToLoad = selectedConflictReviewFile ?? activeFile
    if (!fileToLoad || (activeFile?.mode === 'conflict-review' && !selectedConflictReviewFile)) {
      return
    }
    if (fileToLoad.mode === 'edit' || fileToLoad.mode === 'markdown-preview') {
      if (fileToLoad.conflict?.kind === 'conflict-placeholder') {
        return
      }
      if (needsFileRead(fileToLoad.id)) {
        void loadFileContent(
          fileToLoad.filePath,
          fileToLoad.id,
          fileToLoad.worktreeId,
          fileToLoad.relativePath,
          load
        )
      }
      if (isChangesMode && needsDiffRead(fileToLoad.id)) {
        void loadDiffContent(fileToLoad)
      }
    } else if (isReloadableSingleFileDiffTab(fileToLoad) && needsDiffRead(fileToLoad.id)) {
      void loadDiffContent(fileToLoad)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeFile?.id,
    activeFile?.mode,
    activeFile?.conflictReview?.selectedFileId,
    activeFile?.conflictReview?.snapshotTimestamp,
    selectedConflictReviewFile?.id,
    isChangesMode,
    isVisible,
    gitStatusEntries,
    overviewViewsKey
  ])
}
