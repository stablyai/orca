import { useEffect, type MutableRefObject } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import type { useAppStore } from '@/store'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import { isReloadableSingleFileDiffTab } from './editor-panel-diff-reload'
import type { EditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'
import type { EditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'

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

// Why: the newest read for a tab is already on its way, so a re-run of the lazy
// effect (a worktree flip-flop re-adds `isVisible`) must not fire a second RPC.
// An invalidation bumps the tab's generation, so a superseded read never counts.
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

  useEffect(() => {
    if (!isVisible) {
      return
    }
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
        if (needsFileRead(absolutePath)) {
          void loadFileContent(absolutePath, absolutePath, activeFile.worktreeId, entry.path)
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
          fileToLoad.relativePath
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
    gitStatusEntries
  ])
}
