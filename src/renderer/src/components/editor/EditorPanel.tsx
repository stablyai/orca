import React, { useCallback, useEffect, useState, lazy, Suspense } from 'react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { getEditorHeaderCopyState } from './editor-header'

const MonacoEditor = lazy(() => import('./MonacoEditor'))
const DiffViewer = lazy(() => import('./DiffViewer'))
const CombinedDiffViewer = lazy(() => import('./CombinedDiffViewer'))

type FileContent = {
  content: string
  isBinary: boolean
}

type DiffContent = {
  originalContent: string
  modifiedContent: string
}

export default function EditorPanel(): React.JSX.Element | null {
  const openFiles = useAppStore((s) => s.openFiles)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const markFileDirty = useAppStore((s) => s.markFileDirty)
  const pendingEditorReveal = useAppStore((s) => s.pendingEditorReveal)

  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null

  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const [editBuffers, setEditBuffers] = useState<Record<string, string>>({})
  const [copiedPathToast, setCopiedPathToast] = useState<{ fileId: string; token: number } | null>(
    null
  )

  // Load file content when active file changes
  useEffect(() => {
    if (!activeFile) {
      return
    }
    if (activeFile.mode === 'edit') {
      if (fileContents[activeFile.id]) {
        return
      }
      void loadFileContent(activeFile.filePath, activeFile.id)
    } else if (activeFile.mode === 'diff' && activeFile.diffStaged !== undefined) {
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

  const loadFileContent = async (filePath: string, id: string): Promise<void> => {
    try {
      const result = (await window.api.fs.readFile({ filePath })) as FileContent
      setFileContents((prev) => ({ ...prev, [id]: result }))
    } catch (err) {
      setFileContents((prev) => ({
        ...prev,
        [id]: { content: `Error loading file: ${err}`, isBinary: false }
      }))
    }
  }

  const loadDiffContent = async (file: typeof activeFile): Promise<void> => {
    if (!file) {
      return
    }
    try {
      // Extract worktree path from absolute file path and relative path
      const worktreePath = file.filePath.slice(
        0,
        file.filePath.length - file.relativePath.length - 1
      )
      const result = (await window.api.git.diff({
        worktreePath,
        filePath: file.relativePath,
        staged: file.diffStaged ?? false
      })) as DiffContent
      setDiffContents((prev) => ({ ...prev, [file.id]: result }))
    } catch (err) {
      setDiffContents((prev) => ({
        ...prev,
        [file.id]: { originalContent: '', modifiedContent: `Error loading diff: ${err}` }
      }))
    }
  }

  const handleContentChange = useCallback(
    (content: string) => {
      if (!activeFile) {
        return
      }
      setEditBuffers((prev) => ({ ...prev, [activeFile.id]: content }))
      if (activeFile.mode === 'edit') {
        // Compare against saved content to determine dirty state
        const saved = fileContents[activeFile.id]?.content ?? ''
        markFileDirty(activeFile.id, content !== saved)
      } else {
        // Diff mode: compare against the original modified content from git
        const dc = diffContents[activeFile.id]
        const original = dc?.modifiedContent ?? ''
        markFileDirty(activeFile.id, content !== original)
      }
    },
    [activeFile, markFileDirty, fileContents, diffContents]
  )

  const handleSave = useCallback(
    async (content: string) => {
      if (!activeFile) {
        return
      }
      try {
        await window.api.fs.writeFile({ filePath: activeFile.filePath, content })
        markFileDirty(activeFile.id, false)
        if (activeFile.mode === 'edit') {
          setFileContents((prev) => ({
            ...prev,
            [activeFile.id]: { content, isBinary: false }
          }))
        } else {
          // Update the diff's modified content baseline so dirty tracking stays correct
          setDiffContents((prev) => {
            const existing = prev[activeFile.id]
            if (!existing) {
              return prev
            }
            return {
              ...prev,
              [activeFile.id]: { ...existing, modifiedContent: content }
            }
          })
        }
        // Clear the edit buffer since it now matches saved state
        setEditBuffers((prev) => {
          const next = { ...prev }
          delete next[activeFile.id]
          return next
        })
      } catch (err) {
        console.error('Save failed:', err)
      }
    },
    [activeFile, markFileDirty]
  )

  // Handle save-and-close events from the save confirmation dialog
  useEffect(() => {
    const handler = async (e: Event): Promise<void> => {
      const { fileId } = (e as CustomEvent).detail as { fileId: string }
      const file = useAppStore.getState().openFiles.find((f) => f.id === fileId)
      if (!file) {
        return
      }
      const buffer = editBuffers[fileId]
      if (buffer !== undefined) {
        try {
          await window.api.fs.writeFile({ filePath: file.filePath, content: buffer })
          markFileDirty(fileId, false)
          setFileContents((prev) => ({
            ...prev,
            [fileId]: { content: buffer, isBinary: false }
          }))
        } catch (err) {
          console.error('Save failed:', err)
          return // Don't close if save fails
        }
      }
      useAppStore.getState().closeFile(fileId)
    }
    window.addEventListener('orca:save-and-close', handler as EventListener)
    return () => window.removeEventListener('orca:save-and-close', handler as EventListener)
  }, [editBuffers, markFileDirty])

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

  const isCombinedDiff = activeFile.mode === 'diff' && activeFile.diffStaged === undefined
  const headerCopyState = getEditorHeaderCopyState(activeFile)
  const resolvedLanguage =
    activeFile.mode === 'diff'
      ? detectLanguage(activeFile.relativePath)
      : detectLanguage(activeFile.filePath)

  const loadingFallback = (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
      Loading editor...
    </div>
  )

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
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
      </div>
      <Suspense fallback={loadingFallback}>
        {isCombinedDiff ? (
          <CombinedDiffViewer worktreePath={activeFile.filePath} />
        ) : activeFile.mode === 'edit' ? (
          (() => {
            const fc = fileContents[activeFile.id]
            if (!fc) {
              return (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  Loading...
                </div>
              )
            }
            if (fc.isBinary) {
              return (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  Binary file — cannot display
                </div>
              )
            }
            return (
              <MonacoEditor
                filePath={activeFile.filePath}
                relativePath={activeFile.relativePath}
                content={editBuffers[activeFile.id] ?? fc.content}
                language={resolvedLanguage}
                onContentChange={handleContentChange}
                onSave={handleSave}
                revealLine={pendingEditorReveal?.line}
                revealColumn={pendingEditorReveal?.column}
                revealMatchLength={pendingEditorReveal?.matchLength}
              />
            )
          })()
        ) : (
          (() => {
            const dc = diffContents[activeFile.id]
            if (!dc) {
              return (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                  Loading diff...
                </div>
              )
            }
            // Unstaged diffs are editable (right side = working tree file)
            const isEditable = activeFile.diffStaged === false
            return (
              <DiffViewer
                originalContent={dc.originalContent}
                modifiedContent={editBuffers[activeFile.id] ?? dc.modifiedContent}
                language={resolvedLanguage}
                filePath={activeFile.relativePath}
                editable={isEditable}
                onContentChange={isEditable ? handleContentChange : undefined}
                onSave={isEditable ? handleSave : undefined}
              />
            )
          })()
        )}
      </Suspense>
    </div>
  )
}
