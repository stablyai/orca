/* eslint-disable max-lines -- Why: EditorPanel still owns the visible editor
save/load/render lifecycle for many modes (edit, diff, conflict review), and
keeping that UI state together is easier to reason about than scattering it
across multiple components. Autosave now lives in a smaller headless controller
so hidden editor UI no longer participates in shutdown. */
import React, { useCallback, useEffect, useRef, useState, Suspense } from 'react'
import { Columns2, FileText, Rows2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { getEditorHeaderCopyState, getEditorHeaderOpenFileState } from './editor-header'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import MarkdownViewToggle from './MarkdownViewToggle'
import { EditorContent } from './EditorContent'
import type { GitDiffResult, GitStatusEntry } from '../../../../shared/types'
import {
  getOpenFilesForExternalFileChange,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  requestEditorFileSave,
  type EditorFileSavedDetail,
  type EditorPathMutationTarget
} from './editor-autosave'

type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

type DiffContent = GitDiffResult

// Why: Hoisted to module scope so the JSX reference is stable across renders,
// avoiding prop-identity changes that would defeat React.memo on EditorFilePane.
const LOADING_FALLBACK = (
  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
    Loading editor...
  </div>
)

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
  const editorDrafts = useAppStore((s) => s.editorDrafts)
  const setEditorDraft = useAppStore((s) => s.setEditorDraft)
  const settings = useAppStore((s) => s.settings)

  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null

  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const [copiedPathToast, setCopiedPathToast] = useState<{ fileId: string; token: number } | null>(
    null
  )
  const [sideBySide, setSideBySide] = useState(settings?.diffDefaultView === 'side-by-side')
  const [prevDiffView, setPrevDiffView] = useState(settings?.diffDefaultView)

  // Why: When the user changes their global diff-view preference in Settings,
  // sync the local toggle to match during render (avoids flash of stale diff mode).
  if (settings?.diffDefaultView !== prevDiffView) {
    setPrevDiffView(settings?.diffDefaultView)
    if (settings?.diffDefaultView !== undefined) {
      setSideBySide(settings.diffDefaultView === 'side-by-side')
    }
  }

  const openFilesRef = React.useRef(openFiles)
  openFilesRef.current = openFiles

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

  // Why: handleContentChange and handleSave are parameterised by fileId so that
  // each keep-mounted editor pane uses a handler scoped to its own file, avoiding
  // cross-talk when an inactive editor's content-sync effect fires.

  // Why: fileContents and diffContents change reference on every load, which would
  // recreate this callback and defeat React.memo on every EditorFilePane. Using
  // refs lets the callback read the latest records without being a dependency.
  const fileContentsRef = useRef(fileContents)
  fileContentsRef.current = fileContents
  const diffContentsRef = useRef(diffContents)
  diffContentsRef.current = diffContents

  const handleContentChangeForFile = useCallback(
    (fileId: string, fileMode: OpenFile['mode'], content: string) => {
      setEditorDraft(fileId, content)
      if (fileMode === 'edit') {
        const saved = fileContentsRef.current[fileId]?.content ?? ''
        markFileDirty(fileId, content !== saved)
      } else {
        const dc = diffContentsRef.current[fileId]
        const original = dc?.kind === 'text' ? dc.modifiedContent : ''
        markFileDirty(fileId, content !== original)
      }
    },
    [markFileDirty, setEditorDraft]
  )

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
  }, [loadDiffContent, loadFileContent])

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
  }, [openFiles])

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<EditorFileSavedDetail>).detail
      if (!detail) {
        return
      }

      const file = openFilesRef.current.find((openFile) => openFile.id === detail.fileId)
      if (!file) {
        return
      }

      if (file.mode === 'edit') {
        setFileContents((prev) => ({
          ...prev,
          [file.id]: { content: detail.content, isBinary: false }
        }))
        return
      }

      setDiffContents((prev) => {
        const existing = prev[file.id]
        if (!existing || existing.kind !== 'text') {
          return prev
        }
        return {
          ...prev,
          [file.id]: { ...existing, modifiedContent: detail.content }
        }
      })
    }

    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler as EventListener)
    return () => window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, handler as EventListener)
  }, [])

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
      {/* Why: All open editors stay mounted and only the active one is visible.
       * This preserves scroll position natively via the browser DOM — no save/
       * restore cycle needed for tab switches. Inactive panes use visibility:hidden
       * (not display:none) so the DOM retains layout dimensions and scrollTop. */}
      <div className="relative min-h-0 flex-1">
        {openFiles.map((file) => (
          <EditorFilePane
            key={file.id}
            file={file}
            isActive={file.id === activeFileId}
            fileContent={fileContents[file.id]}
            diffContent={diffContents[file.id]}
            editBuffer={editorDrafts[file.id]}
            worktreeEntries={gitStatusByWorktree[file.worktreeId]}
            markdownViewModeForFile={markdownViewMode[file.id]}
            sideBySide={sideBySide}
            pendingEditorReveal={file.id === activeFileId ? pendingEditorReveal : null}
            onContentChange={handleContentChangeForFile}
          />
        ))}
      </div>
    </div>
  )
}

// Why: Each open file gets its own component instance so useCallback can produce
// stable per-file handlers. Without this, creating closures inside the map would
// recreate handlers on every render, causing unnecessary child re-renders.
// Wrapped in React.memo so that panes whose per-file slices haven't changed
// skip re-rendering when unrelated files update.
const EditorFilePane = React.memo(function EditorFilePane({
  file,
  isActive,
  fileContent,
  diffContent,
  editBuffer,
  worktreeEntries,
  markdownViewModeForFile,
  sideBySide,
  pendingEditorReveal,
  onContentChange
}: {
  file: OpenFile
  isActive: boolean
  fileContent: FileContent | undefined
  diffContent: DiffContent | undefined
  editBuffer: string | undefined
  worktreeEntries: GitStatusEntry[] | undefined
  markdownViewModeForFile: MarkdownViewMode | undefined
  sideBySide: boolean
  pendingEditorReveal: {
    filePath?: string
    line?: number
    column?: number
    matchLength?: number
  } | null
  onContentChange: (fileId: string, fileMode: OpenFile['mode'], content: string) => void
}): React.JSX.Element {
  const resolvedWorktreeEntries = worktreeEntries ?? []
  const resolvedLanguage =
    file.mode === 'diff' ? detectLanguage(file.relativePath) : detectLanguage(file.filePath)
  const isMarkdown = resolvedLanguage === 'markdown'
  const mdViewMode: MarkdownViewMode =
    isMarkdown && file.mode === 'edit' ? (markdownViewModeForFile ?? 'rich') : 'source'

  const handleContentChange = useCallback(
    (content: string) => {
      onContentChange(file.id, file.mode, content)
    },
    [file.id, file.mode, onContentChange]
  )

  const handleSave = useCallback(
    async (content: string) => {
      try {
        await requestEditorFileSave({ fileId: file.id, fallbackContent: content })
      } catch (err) {
        // Why: Logging rather than silently swallowing so save failures are
        // visible during development and in production diagnostics.
        console.error('Save failed:', err)
      }
    },
    [file.id]
  )

  return (
    <div
      className={`absolute inset-0 flex flex-col${isActive ? '' : ' invisible pointer-events-none'}`}
    >
      <Suspense fallback={LOADING_FALLBACK}>
        <EditorContent
          activeFile={file}
          fileContent={fileContent}
          diffContent={diffContent}
          editBuffer={editBuffer}
          worktreeEntries={resolvedWorktreeEntries}
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
})
