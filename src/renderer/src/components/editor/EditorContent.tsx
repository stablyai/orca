import React, { lazy } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { ConflictBanner, ConflictPlaceholderView, ConflictReviewPanel } from './ConflictComponents'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry, GitDiffResult } from '../../../../shared/types'

const MonacoEditor = lazy(() => import('./MonacoEditor'))
const DiffViewer = lazy(() => import('./DiffViewer'))
const CombinedDiffViewer = lazy(() => import('./CombinedDiffViewer'))
const MarkdownPreview = lazy(() => import('./MarkdownPreview'))
const ImageViewer = lazy(() => import('./ImageViewer'))
const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))

type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

type MarkdownViewMode = 'source' | 'preview'

export function EditorContent({
  activeFile,
  fileContents,
  diffContents,
  editBuffers,
  worktreeEntries,
  resolvedLanguage,
  isMarkdown,
  mdViewMode,
  sideBySide,
  pendingEditorReveal,
  handleContentChange,
  handleSave
}: {
  activeFile: OpenFile
  fileContents: Record<string, FileContent>
  diffContents: Record<string, GitDiffResult>
  editBuffers: Record<string, string>
  worktreeEntries: GitStatusEntry[]
  resolvedLanguage: string
  isMarkdown: boolean
  mdViewMode: MarkdownViewMode
  sideBySide: boolean
  pendingEditorReveal: { line?: number; column?: number; matchLength?: number } | null
  handleContentChange: (content: string) => void
  handleSave: (content: string) => Promise<void>
}): React.JSX.Element {
  const openConflictFile = useAppStore((s) => s.openConflictFile)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const closeFile = useAppStore((s) => s.closeFile)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)

  const activeConflictEntry =
    worktreeEntries.find((entry) => entry.path === activeFile.relativePath) ?? null

  const isCombinedDiff =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'combined-uncommitted' ||
      activeFile.diffSource === 'combined-branch')

  const renderMonacoEditor = (fc: FileContent): React.JSX.Element => (
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

  const renderMarkdownContent = (fc: FileContent): React.JSX.Element => {
    const currentContent = editBuffers[activeFile.id] ?? fc.content
    if (mdViewMode === 'preview') {
      return <MarkdownPreview content={currentContent} filePath={activeFile.filePath} />
    }
    return renderMonacoEditor(fc)
  }

  if (activeFile.mode === 'conflict-review') {
    return (
      <ConflictReviewPanel
        file={activeFile}
        liveEntries={worktreeEntries}
        onOpenEntry={(entry) =>
          openConflictFile(
            activeFile.worktreeId,
            activeFile.filePath,
            entry,
            detectLanguage(entry.path)
          )
        }
        onDismiss={() => closeFile(activeFile.id)}
        onRefreshSnapshot={() =>
          openConflictReview(
            activeFile.worktreeId,
            activeFile.filePath,
            worktreeEntries
              .filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind)
              .map((entry) => ({
                path: entry.path,
                conflictKind: entry.conflictKind!
              })),
            'live-summary'
          )
        }
        onReturnToSourceControl={() => setRightSidebarTab('source-control')}
      />
    )
  }

  if (isCombinedDiff) {
    return <CombinedDiffViewer file={activeFile} />
  }

  if (activeFile.mode === 'edit') {
    if (activeFile.conflict?.kind === 'conflict-placeholder') {
      return <ConflictPlaceholderView file={activeFile} />
    }
    const fc = fileContents[activeFile.id]
    if (!fc) {
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Loading...
        </div>
      )
    }
    if (fc.isBinary) {
      if (fc.isImage) {
        return (
          <ImageViewer content={fc.content} filePath={activeFile.filePath} mimeType={fc.mimeType} />
        )
      }
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Binary file — cannot display
        </div>
      )
    }
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {activeFile.conflict && <ConflictBanner file={activeFile} entry={activeConflictEntry} />}
        <div className="min-h-0 flex-1 relative">
          {isMarkdown ? renderMarkdownContent(fc) : renderMonacoEditor(fc)}
        </div>
      </div>
    )
  }

  // Diff mode
  const dc = diffContents[activeFile.id]
  if (!dc) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading diff...
      </div>
    )
  }
  const isEditable = activeFile.diffSource === 'unstaged'
  if (dc.kind === 'binary') {
    if (dc.isImage) {
      return (
        <ImageDiffViewer
          originalContent={dc.originalContent}
          modifiedContent={dc.modifiedContent}
          filePath={activeFile.relativePath}
          mimeType={dc.mimeType}
          sideBySide={sideBySide}
        />
      )
    }
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">Binary file changed</div>
          <div className="text-xs text-muted-foreground">
            {activeFile.diffSource === 'branch'
              ? 'Text diff is unavailable for this file in branch compare.'
              : 'Text diff is unavailable for this file.'}
          </div>
        </div>
      </div>
    )
  }
  return (
    <DiffViewer
      originalContent={dc.originalContent}
      modifiedContent={editBuffers[activeFile.id] ?? dc.modifiedContent}
      language={resolvedLanguage}
      sideBySide={sideBySide}
      editable={isEditable}
      onContentChange={isEditable ? handleContentChange : undefined}
      onSave={isEditable ? handleSave : undefined}
    />
  )
}
