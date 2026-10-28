import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { useAppStore } from '@/store'
import type { DiffContent, FileContent } from './editor-panel-content-types'
import {
  useEditorPanelExternalContentEvents,
  usePruneClosedEditorContent
} from './useEditorPanelExternalContentEvents'
import { useEditorPanelFileLoadRetry } from './useEditorPanelFileLoadRetry'
import { useLocalLogTail } from './useLocalLogTail'
import { useEditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'
import { useEditorPanelDiffContentLoader } from './useEditorPanelDiffContentLoader'
import { useEditorPanelActiveTabContentLoad } from './useEditorPanelActiveTabContentLoad'
import { useEditorPanelContentReloadTriggers } from './useEditorPanelContentReloadTriggers'

type GitStatusByWorktree = ReturnType<typeof useAppStore.getState>['gitStatusByWorktree']
type EditorViewModeByFile = ReturnType<typeof useAppStore.getState>['editorViewMode']

type UseEditorPanelContentStateParams = {
  activeFile: OpenFile | null
  isVisible?: boolean
  isChangesMode: boolean
  openFiles: OpenFile[]
  gitStatusEntries: GitStatusByWorktree[string] | undefined
  editorViewMode: EditorViewModeByFile
}

type UseEditorPanelContentStateResult = {
  fileContents: Record<string, FileContent>
  diffContents: Record<string, DiffContent>
  reloadContent: (file: OpenFile, options?: { wakeWslDistro?: boolean }) => void
}

export function useEditorPanelContentState({
  activeFile,
  isVisible = true,
  isChangesMode,
  openFiles,
  gitStatusEntries,
  editorViewMode
}: UseEditorPanelContentStateParams): UseEditorPanelContentStateResult {
  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const diffContentsRef = useRef(diffContents)
  const fileLoadRetryAttemptsRef = useRef<Record<string, number>>({})
  // Generation fences keep slow superseded reads from overwriting newer content.
  const fileReadGenerationRef = useRef<Record<string, number>>({})
  const diffReadGenerationRef = useRef<Record<string, number>>({})
  const fileReadGenerationCounterRef = useRef(0)
  const diffReadGenerationCounterRef = useRef(0)
  const outstandingFileReadsRef = useRef<Record<string, number>>({})
  const outstandingDiffReadsRef = useRef<Record<string, number>>({})
  const openFilesRef = useRef(openFiles)
  const editorViewModeRef = useRef(editorViewMode)
  const isVisibleRef = useRef(isVisible)
  const selectedConflictReviewFile =
    activeFile?.mode === 'conflict-review' && activeFile.conflictReview?.selectedFileId
      ? (openFiles.find((file) => file.id === activeFile.conflictReview?.selectedFileId) ?? null)
      : null
  const activeContentFileId = selectedConflictReviewFile?.id ?? activeFile?.id ?? null
  const activeContentFileIdRef = useRef(activeContentFileId)

  useLayoutEffect(() => {
    // Why: event-driven readers must only observe state from committed renders.
    diffContentsRef.current = diffContents
    openFilesRef.current = openFiles
    editorViewModeRef.current = editorViewMode
    isVisibleRef.current = isVisible
    activeContentFileIdRef.current = activeContentFileId
  }, [activeContentFileId, diffContents, editorViewMode, isVisible, openFiles])

  const supersedeFileReads = useCallback((fileIds: readonly string[]): void => {
    for (const fileId of fileIds) {
      fileReadGenerationRef.current[fileId] = ++fileReadGenerationCounterRef.current
    }
  }, [])

  const invalidateFileContent = useCallback((fileIds: string[]): void => {
    const uniqueIds = new Set(fileIds)
    for (const fileId of uniqueIds) {
      fileReadGenerationRef.current[fileId] = ++fileReadGenerationCounterRef.current
      delete fileLoadRetryAttemptsRef.current[fileId]
    }
    setFileContents((prev) => {
      const next = { ...prev }
      let changed = false
      for (const fileId of uniqueIds) {
        const existing = next[fileId]
        // Keep last-known text until lazy reload lands to avoid Loading flashes on reveal.
        if (existing && existing.isStale !== true) {
          next[fileId] = { ...existing, isStale: true }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const invalidateDiffContent = useCallback((fileIds: string[]): void => {
    const uniqueIds = new Set(fileIds)
    for (const fileId of uniqueIds) {
      diffReadGenerationRef.current[fileId] = ++diffReadGenerationCounterRef.current
    }
    setDiffContents((prev) => {
      const next = { ...prev }
      let changed = false
      for (const fileId of uniqueIds) {
        const existing = next[fileId]
        // Keep the last-known diff until lazy reload lands to avoid Loading diff flashes on reveal.
        if (existing && existing.isStale !== true) {
          next[fileId] = { ...existing, isStale: true }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  const invalidateContent = useCallback(
    (fileIds: string[]): void => {
      invalidateFileContent(fileIds)
      invalidateDiffContent(fileIds)
    },
    [invalidateDiffContent, invalidateFileContent]
  )

  const loadFileContent = useEditorPanelFileContentLoader({
    fileLoadRetryAttemptsRef,
    fileReadGenerationCounterRef,
    fileReadGenerationRef,
    openFilesRef,
    outstandingFileReadsRef,
    setFileContents
  })

  const loadDiffContent = useEditorPanelDiffContentLoader({
    diffReadGenerationCounterRef,
    diffReadGenerationRef,
    outstandingDiffReadsRef,
    setDiffContents
  })

  // Route explicit reloads by mode so diff banners refresh diff bodies instead of plain-file caches.
  const reloadContent = useCallback(
    (file: OpenFile, options?: { wakeWslDistro?: boolean }): void => {
      if (file.mode === 'diff') {
        setDiffContents((prev) => {
          if (!prev[file.id]) {
            return prev
          }
          const next = { ...prev }
          delete next[file.id]
          return next
        })
        void loadDiffContent(file, { force: true })
        return
      }
      delete fileLoadRetryAttemptsRef.current[file.id]
      setFileContents((prev) => {
        if (!prev[file.id]) {
          return prev
        }
        const next = { ...prev }
        delete next[file.id]
        return next
      })
      void loadFileContent(file.filePath, file.id, file.worktreeId, file.relativePath, {
        force: true,
        ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
      })
    },
    [loadDiffContent, loadFileContent]
  )

  useLocalLogTail({ openFiles, fileContents, setFileContents, reloadContent })

  useEditorPanelActiveTabContentLoad({
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
  })

  useEditorPanelFileLoadRetry({
    activeFile: isVisible ? activeFile : null,
    fileContents,
    fileLoadRetryAttemptsRef,
    loadFileContent,
    openFilesRef,
    setFileContents
  })

  useEditorPanelContentReloadTriggers({
    activeFile,
    gitStatusEntries,
    isChangesMode,
    diffContentsRef,
    isVisibleRef,
    openFilesRef,
    invalidateDiffContent,
    invalidateFileContent,
    loadDiffContent,
    loadFileContent
  })

  useEditorPanelExternalContentEvents({
    activeContentFileIdRef,
    invalidateContent,
    invalidateDiffContent,
    isVisibleRef,
    loadDiffContent,
    loadFileContent,
    openFilesRef,
    editorViewModeRef,
    setFileContents,
    setDiffContents,
    supersedeFileReads
  })
  usePruneClosedEditorContent(
    openFiles,
    fileLoadRetryAttemptsRef,
    fileReadGenerationRef,
    diffReadGenerationRef,
    setFileContents,
    setDiffContents
  )

  return { fileContents, diffContents, reloadContent }
}
