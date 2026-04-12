import React, { lazy } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { ConflictBanner, ConflictPlaceholderView, ConflictReviewPanel } from './ConflictComponents'
import type { OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry, GitDiffResult } from '../../../../shared/types'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import { getMarkdownRenderMode } from './markdown-render-mode'
import { getMarkdownRichModeUnsupportedMessage } from './markdown-rich-mode'

const MonacoEditor = lazy(() => import('./MonacoEditor'))
const DiffViewer = lazy(() => import('./DiffViewer'))
const CombinedDiffViewer = lazy(() => import('./CombinedDiffViewer'))
const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor'))
const MarkdownPreview = lazy(() => import('./MarkdownPreview'))
const ImageViewer = lazy(() => import('./ImageViewer'))
const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))

const richMarkdownSizeEncoder = new TextEncoder()
// Why: encodeInto() with a pre-allocated buffer avoids creating a new
// Uint8Array on every render, reducing GC pressure for large files.
const richMarkdownSizeBuffer = new Uint8Array(RICH_MARKDOWN_MAX_SIZE_BYTES + 1)

type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
}

type MarkdownViewMode = 'source' | 'rich'

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
  handleDirtyStateHint,
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
  pendingEditorReveal: {
    filePath?: string
    line?: number
    column?: number
    matchLength?: number
  } | null
  handleContentChange: (content: string) => void
  handleDirtyStateHint: (dirty: boolean) => void
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
    // Why: Without a key, React reuses the same MonacoEditor instance when
    // switching tabs, just updating props. That means useLayoutEffect cleanup
    // (which snapshots scroll position) never fires. Keying on activeFile.id
    // forces unmount/remount so the scroll cache captures the outgoing position.
    <MonacoEditor
      key={activeFile.id}
      filePath={activeFile.filePath}
      relativePath={activeFile.relativePath}
      content={editBuffers[activeFile.id] ?? fc.content}
      language={resolvedLanguage}
      onContentChange={handleContentChange}
      onSave={handleSave}
      revealLine={
        pendingEditorReveal?.filePath === activeFile.filePath ? pendingEditorReveal.line : undefined
      }
      revealColumn={
        pendingEditorReveal?.filePath === activeFile.filePath
          ? pendingEditorReveal.column
          : undefined
      }
      revealMatchLength={
        pendingEditorReveal?.filePath === activeFile.filePath
          ? pendingEditorReveal.matchLength
          : undefined
      }
    />
  )

  const renderMarkdownContent = (fc: FileContent): React.JSX.Element => {
    const currentContent = editBuffers[activeFile.id] ?? fc.content
    const richModeUnsupportedMessage = getMarkdownRichModeUnsupportedMessage(currentContent)
    const renderMode = getMarkdownRenderMode({
      // Why: the threshold is defined in bytes because large pasted Unicode
      // documents can exceed ProseMirror's performance envelope long before
      // JS string length reaches the same numeric value.
      exceedsRichModeSizeLimit:
        richMarkdownSizeEncoder.encodeInto(currentContent, richMarkdownSizeBuffer).written >
        RICH_MARKDOWN_MAX_SIZE_BYTES,
      hasRichModeUnsupportedContent: richModeUnsupportedMessage !== null,
      viewMode: mdViewMode
    })

    // Why: the render-mode helper already folded size into the mode decision.
    // Keep the explanatory banner here so the user understands why "rich" view
    // currently shows Monaco instead.
    if (renderMode === 'source' && mdViewMode === 'rich') {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-border/60 bg-blue-500/10 px-3 py-2 text-xs text-blue-950 dark:text-blue-100">
            File is too large for rich editing. Showing source mode instead.
          </div>
          <div className="min-h-0 flex-1 h-full">{renderMonacoEditor(fc)}</div>
        </div>
      )
    }

    if (renderMode === 'rich-editor') {
      return (
        // Why: same remount reasoning as MonacoEditor — see renderMonacoEditor.
        <RichMarkdownEditor
          key={activeFile.id}
          fileId={activeFile.id}
          content={currentContent}
          filePath={activeFile.filePath}
          onContentChange={handleContentChange}
          onDirtyStateHint={handleDirtyStateHint}
          onSave={handleSave}
        />
      )
    }

    if (renderMode === 'preview') {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-border/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
            {richModeUnsupportedMessage}
          </div>
          {/* Why: before rich editing shipped, Orca already had a stable markdown
          preview surface. If Tiptap cannot safely own a document, falling back
          to that renderer preserves readable preview mode instead of forcing the
          user out of preview entirely. Source mode remains available for edits. */}
          <div className="min-h-0 flex-1">
            <MarkdownPreview
              key={activeFile.id}
              content={currentContent}
              filePath={activeFile.filePath}
            />
          </div>
        </div>
      )
    }

    // Why: Monaco sizes itself against the immediate parent when `height="100%"`
    // is used. Markdown source mode briefly wrapped it in a non-flex container
    // with no explicit height, which made the code surface collapse even though
    // the surrounding editor pane was tall enough.
    return <div className="h-full min-h-0">{renderMonacoEditor(fc)}</div>
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
    return <CombinedDiffViewer key={activeFile.id} file={activeFile} />
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
      filePath={activeFile.filePath}
      relativePath={activeFile.relativePath}
      sideBySide={sideBySide}
      editable={isEditable}
      onContentChange={isEditable ? handleContentChange : undefined}
      onSave={isEditable ? handleSave : undefined}
    />
  )
}
