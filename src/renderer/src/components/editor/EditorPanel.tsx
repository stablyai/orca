/* eslint-disable max-lines -- Why: EditorPanel owns the editor tab save/load
lifecycle end-to-end, including autosave coordination with external mutations.
Keeping that state machine co-located avoids subtle regressions from splitting
the tightly-coupled effects, refs, and event handlers across multiple modules. */
import React, { useCallback, useEffect, useState, Suspense } from 'react'
import { Columns2, FileText, Rows2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { getEditorHeaderCopyState, getEditorHeaderOpenFileState } from './editor-header'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import MarkdownViewToggle from './MarkdownViewToggle'
import { EditorContent } from './EditorContent'
import type { GitDiffResult } from '../../../../shared/types'
import {
  canAutoSaveOpenFile,
  getOpenFilesForExternalFileChange,
  normalizeAutoSaveDelayMs,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT,
  type EditorPathMutationTarget,
  type EditorSaveQuiesceDetail
} from './editor-autosave'

type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

type DiffContent = GitDiffResult

export default function EditorPanel(): React.JSX.Element | null {
  const openFiles = useAppStore((s) => s.openFiles)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const pendingEditorReveal = useAppStore((s) => s.pendingEditorReveal)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree)
  const markdownViewMode = useAppStore((s) => s.markdownViewMode)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const openFile = useAppStore((s) => s.openFile)
  const settings = useAppStore((s) => s.settings)

  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null

  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const [editBuffers, setEditBuffers] = useState<Record<string, string>>({})
  const [copiedPathToast, setCopiedPathToast] = useState<{ fileId: string; token: number } | null>(
    null
  )
  const [sideBySide, setSideBySide] = useState(true)
  const autoSaveTimersRef = React.useRef<Map<string, number>>(new Map())
  const autoSaveScheduledContentRef = React.useRef<Map<string, string>>(new Map())
  const saveQueueRef = React.useRef<Map<string, Promise<void>>>(new Map())
  const saveGenerationRef = React.useRef<Map<string, number>>(new Map())
  const openFilesRef = React.useRef(openFiles)
  const editBuffersRef = React.useRef(editBuffers)
  const autoSaveDelayMs = normalizeAutoSaveDelayMs(settings?.editorAutoSaveDelayMs)
  openFilesRef.current = openFiles
  editBuffersRef.current = editBuffers

  const clearAutoSaveTimer = useCallback((fileId: string): void => {
    const timerId = autoSaveTimersRef.current.get(fileId)
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
      autoSaveTimersRef.current.delete(fileId)
    }
    autoSaveScheduledContentRef.current.delete(fileId)
  }, [])

  const bumpSaveGeneration = useCallback((fileId: string): void => {
    saveGenerationRef.current.set(fileId, (saveGenerationRef.current.get(fileId) ?? 0) + 1)
  }, [])

  // Load file content when active file changes
  useEffect(() => {
    if (!activeFile) {
      return
    }
    if (activeFile.mode === 'conflict-review') {
      return
    }
    if (activeFile.mode === 'edit') {
      if (activeFile.conflict?.kind === 'conflict-placeholder') {
        return
      }
      if (fileContents[activeFile.id]) {
        return
      }
      void loadFileContent(activeFile.filePath, activeFile.id)
    } else if (
      activeFile.mode === 'diff' &&
      activeFile.diffSource !== undefined &&
      activeFile.diffSource !== 'combined-uncommitted' &&
      activeFile.diffSource !== 'combined-branch'
    ) {
      if (diffContents[activeFile.id]) {
        return
      }
      void loadDiffContent(activeFile)
    }
  }, [activeFile?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!copiedPathToast) {
      return
    }
    const timeout = window.setTimeout(() => setCopiedPathToast(null), 1500)
    return () => window.clearTimeout(timeout)
  }, [copiedPathToast])

  const loadFileContent = useCallback(async (filePath: string, id: string): Promise<void> => {
    try {
      const result = (await window.api.fs.readFile({ filePath })) as FileContent
      setFileContents((prev) => ({ ...prev, [id]: result }))
    } catch (err) {
      setFileContents((prev) => ({
        ...prev,
        [id]: { content: `Error loading file: ${err}`, isBinary: false }
      }))
    }
  }, [])

  const loadDiffContent = useCallback(async (file: OpenFile | null): Promise<void> => {
    if (!file) {
      return
    }
    try {
      // Extract worktree path from absolute file path and relative path
      const worktreePath = file.filePath.slice(
        0,
        file.filePath.length - file.relativePath.length - 1
      )
      const branchCompare =
        file.branchCompare?.baseOid && file.branchCompare.headOid && file.branchCompare.mergeBase
          ? file.branchCompare
          : null
      const result =
        file.diffSource === 'branch' && branchCompare
          ? ((await window.api.git.branchDiff({
              worktreePath,
              compare: {
                baseRef: branchCompare.baseRef,
                baseOid: branchCompare.baseOid!,
                headOid: branchCompare.headOid!,
                mergeBase: branchCompare.mergeBase!
              },
              filePath: file.relativePath,
              oldPath: file.branchOldPath
            })) as DiffContent)
          : ((await window.api.git.diff({
              worktreePath,
              filePath: file.relativePath,
              staged: file.diffSource === 'staged'
            })) as DiffContent)
      setDiffContents((prev) => ({ ...prev, [file.id]: result }))
    } catch (err) {
      setDiffContents((prev) => ({
        ...prev,
        [file.id]: {
          kind: 'text',
          originalContent: '',
          modifiedContent: `Error loading diff: ${err}`,
          originalIsBinary: false,
          modifiedIsBinary: false
        }
      }))
    }
  }, [])

  const queueSave = useCallback(
    (file: OpenFile, fallbackContent: string): Promise<void> => {
      clearAutoSaveTimer(file.id)
      const saveGeneration = saveGenerationRef.current.get(file.id) ?? 0

      const previousSave = saveQueueRef.current.get(file.id) ?? Promise.resolve()
      const queuedSave = previousSave
        .catch(() => undefined)
        .then(async () => {
          if ((saveGenerationRef.current.get(file.id) ?? 0) !== saveGeneration) {
            return
          }
          if (!openFilesRef.current.some((openFile) => openFile.id === file.id)) {
            return
          }

          const liveFile = openFilesRef.current.find((openFile) => openFile.id === file.id) ?? file
          const contentToSave = editBuffersRef.current[file.id] ?? fallbackContent

          try {
            await window.api.fs.writeFile({ filePath: liveFile.filePath, content: contentToSave })
            if ((saveGenerationRef.current.get(file.id) ?? 0) !== saveGeneration) {
              return
            }

            if (liveFile.mode === 'edit') {
              setFileContents((prev) => ({
                ...prev,
                [file.id]: { content: contentToSave, isBinary: false }
              }))
            } else {
              setDiffContents((prev) => {
                const existing = prev[file.id]
                if (!existing || existing.kind !== 'text') {
                  return prev
                }
                return {
                  ...prev,
                  [file.id]: { ...existing, modifiedContent: contentToSave }
                }
              })
            }

            const currentBuffer = editBuffersRef.current[file.id]
            const stillDirty = currentBuffer !== undefined && currentBuffer !== contentToSave

            markFileDirty(file.id, stillDirty)
            setEditBuffers((prev) => {
              const bufferedContent = prev[file.id]
              if (bufferedContent === undefined || bufferedContent === contentToSave) {
                const next = { ...prev }
                delete next[file.id]
                editBuffersRef.current = next
                return next
              }
              editBuffersRef.current = prev
              return prev
            })
          } catch (err) {
            console.error('Save failed:', err)
            throw err
          }
        })

      let trackedSave: Promise<void>
      trackedSave = queuedSave.finally(() => {
        if (saveQueueRef.current.get(file.id) === trackedSave) {
          saveQueueRef.current.delete(file.id)
        }
      })
      saveQueueRef.current.set(file.id, trackedSave)
      return trackedSave
    },
    [clearAutoSaveTimer, markFileDirty]
  )

  const quiesceFileSave = useCallback(
    async (fileId: string): Promise<void> => {
      const pendingSave = saveQueueRef.current.get(fileId)
      clearAutoSaveTimer(fileId)
      bumpSaveGeneration(fileId)
      await pendingSave?.catch(() => undefined)
    },
    [bumpSaveGeneration, clearAutoSaveTimer]
  )

  const handleContentChange = useCallback(
    (content: string) => {
      if (!activeFile) {
        return
      }
      const nextBuffers = { ...editBuffersRef.current, [activeFile.id]: content }
      editBuffersRef.current = nextBuffers
      setEditBuffers(nextBuffers)
      if (activeFile.mode === 'edit') {
        // Compare against saved content to determine dirty state
        const saved = fileContents[activeFile.id]?.content ?? ''
        markFileDirty(activeFile.id, content !== saved)
      } else {
        // Diff mode: compare against the original modified content from git
        const dc = diffContents[activeFile.id]
        const original = dc?.kind === 'text' ? dc.modifiedContent : ''
        markFileDirty(activeFile.id, content !== original)
      }

      if (!settings?.editorAutoSave) {
        clearAutoSaveTimer(activeFile.id)
      }
    },
    [
      activeFile,
      clearAutoSaveTimer,
      diffContents,
      fileContents,
      markFileDirty,
      settings?.editorAutoSave
    ]
  )

  const handleSave = useCallback(
    async (content: string) => {
      if (!activeFile) {
        return
      }
      try {
        await queueSave(activeFile, content)
      } catch {}
    },
    [activeFile, queueSave]
  )

  // Handle save-and-close events from the save confirmation dialog
  useEffect(() => {
    const handler = async (e: Event): Promise<void> => {
      const { fileId } = (e as CustomEvent).detail as { fileId: string }
      const file = useAppStore.getState().openFiles.find((f) => f.id === fileId)
      if (!file) {
        return
      }
      const buffer = editBuffersRef.current[fileId]
      if (buffer !== undefined) {
        try {
          await queueSave(file, buffer)
        } catch {
          return // Don't close if save fails
        }
      }
      useAppStore.getState().closeFile(fileId)
    }
    window.addEventListener('orca:save-and-close', handler as EventListener)
    return () => window.removeEventListener('orca:save-and-close', handler as EventListener)
  }, [queueSave])

  useEffect(() => {
    const handler = async (event: Event): Promise<void> => {
      const detail = (event as CustomEvent<EditorSaveQuiesceDetail>).detail
      if (!detail) {
        return
      }
      detail.claim()

      const matchingFiles =
        'fileId' in detail
          ? openFilesRef.current.filter((file) => file.id === detail.fileId)
          : getOpenFilesForExternalFileChange(openFilesRef.current, detail)

      await Promise.all(matchingFiles.map((file) => quiesceFileSave(file.id)))
      detail.resolve()
    }

    window.addEventListener(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, handler as EventListener)
    return () =>
      window.removeEventListener(ORCA_EDITOR_QUIESCE_FILE_SAVES_EVENT, handler as EventListener)
  }, [quiesceFileSave])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
      if (!detail) {
        return
      }

      const matchingFiles = getOpenFilesForExternalFileChange(openFilesRef.current, detail)
      if (matchingFiles.length === 0) {
        return
      }

      const matchingIds = new Set(matchingFiles.map((file) => file.id))

      for (const file of matchingFiles) {
        clearAutoSaveTimer(file.id)
        bumpSaveGeneration(file.id)
        markFileDirty(file.id, false)
      }

      setEditBuffers((prev) => {
        const next = { ...prev }
        for (const fileId of matchingIds) {
          delete next[fileId]
        }
        editBuffersRef.current = next
        return next
      })

      setFileContents((prev) => {
        const next = { ...prev }
        for (const file of matchingFiles) {
          if (file.mode === 'edit') {
            delete next[file.id]
          }
        }
        return next
      })
      setDiffContents((prev) => {
        const next = { ...prev }
        for (const file of matchingFiles) {
          if (file.mode === 'diff') {
            delete next[file.id]
          }
        }
        return next
      })

      for (const file of matchingFiles) {
        if (file.mode === 'edit') {
          void loadFileContent(file.filePath, file.id)
        } else if (
          file.mode === 'diff' &&
          file.diffSource !== 'combined-uncommitted' &&
          file.diffSource !== 'combined-branch'
        ) {
          void loadDiffContent(file)
        }
      }
    }

    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
    return () =>
      window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, handler as EventListener)
  }, [bumpSaveGeneration, clearAutoSaveTimer, loadDiffContent, loadFileContent, markFileDirty])

  useEffect(() => {
    const openFilesById = new Map(openFiles.map((file) => [file.id, file]))

    for (const fileId of Array.from(autoSaveTimersRef.current.keys())) {
      const file = openFilesById.get(fileId)
      const buffer = editBuffers[fileId]
      const shouldKeepTimer =
        settings?.editorAutoSave &&
        file &&
        file.isDirty &&
        canAutoSaveOpenFile(file) &&
        buffer !== undefined
      if (!shouldKeepTimer) {
        clearAutoSaveTimer(fileId)
      }
    }

    if (!settings?.editorAutoSave) {
      return
    }

    for (const file of openFiles) {
      const buffer = editBuffers[file.id]
      if (!file.isDirty || buffer === undefined || !canAutoSaveOpenFile(file)) {
        clearAutoSaveTimer(file.id)
        continue
      }

      if (
        autoSaveTimersRef.current.has(file.id) &&
        autoSaveScheduledContentRef.current.get(file.id) === buffer
      ) {
        continue
      }

      clearAutoSaveTimer(file.id)
      autoSaveScheduledContentRef.current.set(file.id, buffer)
      const timerId = window.setTimeout(() => {
        autoSaveTimersRef.current.delete(file.id)
        autoSaveScheduledContentRef.current.delete(file.id)
        void queueSave(file, buffer)
      }, autoSaveDelayMs)
      autoSaveTimersRef.current.set(file.id, timerId)
    }
  }, [
    autoSaveDelayMs,
    clearAutoSaveTimer,
    editBuffers,
    openFiles,
    queueSave,
    settings?.editorAutoSave
  ])

  useEffect(
    () => () => {
      for (const timerId of autoSaveTimersRef.current.values()) {
        window.clearTimeout(timerId)
      }
      autoSaveTimersRef.current.clear()
      autoSaveScheduledContentRef.current.clear()
    },
    []
  )

  // Clean up content caches when files are closed
  useEffect(() => {
    const openIds = new Set(openFiles.map((f) => f.id))
    setFileContents((prev) => {
      const next: Record<string, FileContent> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (openIds.has(k)) {
          next[k] = v
        }
      }
      return next
    })
    setDiffContents((prev) => {
      const next: Record<string, DiffContent> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (openIds.has(k)) {
          next[k] = v
        }
      }
      return next
    })
    setEditBuffers((prev) => {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (openIds.has(k)) {
          next[k] = v
        }
      }
      editBuffersRef.current = next
      return next
    })
  }, [openFiles])

  const handleCopyPath = useCallback(async (): Promise<void> => {
    if (!activeFile) {
      return
    }
    const copyState = getEditorHeaderCopyState(activeFile)
    if (!copyState.copyText) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(copyState.copyText)
      setCopiedPathToast({ fileId: activeFile.id, token: Date.now() })
    } catch {
      setCopiedPathToast(null)
    }
  }, [activeFile])

  if (!activeFile) {
    return null
  }

  const isSingleDiff =
    activeFile.mode === 'diff' &&
    activeFile.diffSource !== undefined &&
    activeFile.diffSource !== 'combined-uncommitted' &&
    activeFile.diffSource !== 'combined-branch'
  const isCombinedDiff =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'combined-uncommitted' ||
      activeFile.diffSource === 'combined-branch')
  const headerCopyState = getEditorHeaderCopyState(activeFile)
  const worktreeEntries = gitStatusByWorktree[activeFile.worktreeId] ?? []
  const branchEntries = gitBranchChangesByWorktree[activeFile.worktreeId] ?? []
  const resolvedLanguage =
    activeFile.mode === 'diff'
      ? detectLanguage(activeFile.relativePath)
      : detectLanguage(activeFile.filePath)
  const matchingWorktreeEntry =
    activeFile.mode === 'diff' && activeFile.diffSource !== 'branch'
      ? (worktreeEntries.find(
          (entry) =>
            entry.path === activeFile.relativePath &&
            (activeFile.diffSource === 'staged'
              ? entry.area === 'staged'
              : entry.area === 'unstaged')
        ) ?? null)
      : null
  const matchingBranchEntry =
    activeFile.mode === 'diff' && activeFile.diffSource === 'branch'
      ? (branchEntries.find((entry) => entry.path === activeFile.relativePath) ?? null)
      : null
  const openFileState = getEditorHeaderOpenFileState(
    activeFile,
    matchingWorktreeEntry,
    matchingBranchEntry
  )

  const isMarkdown = resolvedLanguage === 'markdown'
  const mdViewMode: MarkdownViewMode =
    isMarkdown && activeFile.mode === 'edit'
      ? (markdownViewMode[activeFile.id] ?? 'rich')
      : 'source'

  const handleOpenDiffTargetFile = (): void => {
    if (!openFileState.canOpen) {
      return
    }
    openFile({
      filePath: activeFile.filePath,
      relativePath: activeFile.relativePath,
      worktreeId: activeFile.worktreeId,
      language: detectLanguage(activeFile.relativePath),
      mode: 'edit'
    })
  }

  const loadingFallback = (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      Loading editor...
    </div>
  )

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      {!isCombinedDiff && (
        <div className="editor-header">
          <div className="editor-header-text">
            <div className="editor-header-path-row">
              <button
                type="button"
                className="editor-header-path"
                onClick={() => void handleCopyPath()}
                title={headerCopyState.pathTitle}
              >
                {headerCopyState.pathLabel}
              </button>
              <span
                className={`editor-header-copy-toast${copiedPathToast?.fileId === activeFile.id ? ' is-visible' : ''}`}
                aria-live="polite"
              >
                {headerCopyState.copyToastLabel}
              </span>
            </div>
          </div>
          {isSingleDiff && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    onClick={handleOpenDiffTargetFile}
                    aria-label="Open file"
                    disabled={!openFileState.canOpen}
                  >
                    <FileText size={14} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {openFileState.canOpen
                    ? isMarkdown
                      ? 'Open file tab to use rich markdown editing'
                      : 'Open file tab'
                    : 'This diff has no modified-side file to open'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {isSingleDiff && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                    onClick={() => setSideBySide((prev) => !prev)}
                  >
                    {sideBySide ? <Rows2 size={14} /> : <Columns2 size={14} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {isMarkdown && activeFile.mode === 'edit' && (
            <MarkdownViewToggle
              mode={mdViewMode}
              onChange={(mode) => setMarkdownViewMode(activeFile.id, mode)}
            />
          )}
        </div>
      )}
      <Suspense fallback={loadingFallback}>
        <EditorContent
          activeFile={activeFile}
          fileContents={fileContents}
          diffContents={diffContents}
          editBuffers={editBuffers}
          worktreeEntries={worktreeEntries}
          resolvedLanguage={resolvedLanguage}
          isMarkdown={isMarkdown}
          mdViewMode={mdViewMode}
          sideBySide={sideBySide}
          pendingEditorReveal={pendingEditorReveal}
          handleContentChange={handleContentChange}
          handleSave={handleSave}
        />
      </Suspense>
    </div>
  )
}
