import React, { useCallback, useEffect, useState, lazy, Suspense } from 'react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'

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

  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null

  const [fileContents, setFileContents] = useState<Record<string, FileContent>>({})
  const [diffContents, setDiffContents] = useState<Record<string, DiffContent>>({})
  const [editBuffers, setEditBuffers] = useState<Record<string, string>>({})

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
      // Compare against saved content to determine dirty state
      const saved = fileContents[activeFile.id]?.content ?? ''
      markFileDirty(activeFile.id, content !== saved)
    },
    [activeFile, markFileDirty, fileContents]
  )

  const handleSave = useCallback(
    async (content: string) => {
      if (!activeFile) {
        return
      }
      try {
        await window.api.fs.writeFile({ filePath: activeFile.filePath, content })
        markFileDirty(activeFile.id, false)
        setFileContents((prev) => ({
          ...prev,
          [activeFile.id]: { content, isBinary: false }
        }))
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

  if (!activeFile) {
    return null
  }

  const isCombinedDiff = activeFile.mode === 'diff' && activeFile.diffStaged === undefined
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
                content={editBuffers[activeFile.id] ?? fc.content}
                language={resolvedLanguage}
                onContentChange={handleContentChange}
                onSave={handleSave}
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
            return (
              <DiffViewer
                originalContent={dc.originalContent}
                modifiedContent={dc.modifiedContent}
                language={resolvedLanguage}
                filePath={activeFile.relativePath}
              />
            )
          })()
        )}
      </Suspense>
    </div>
  )
}
