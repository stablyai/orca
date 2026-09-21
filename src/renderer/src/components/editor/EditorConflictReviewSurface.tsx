import React from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type { OpenFile, PendingEditorReveal } from '@/store/slices/editor'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { ConflictBanner, ConflictPlaceholderView, ConflictReviewPanel } from './ConflictComponents'
import { ImageViewer, MonacoEditor } from './editor-lazy-views'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import type { FileContent } from './editor-panel-content-types'
import { translate } from '@/i18n/i18n'
import type { EditorConflictNavigation } from './useEditorConflictNavigation'

export function EditorConflictReviewSurface({
  activeFile,
  viewStateScopeId,
  fileContents,
  editBuffers,
  openFiles,
  worktreeEntries,
  pendingEditorReveal,
  getConflictNavigation,
  handleContentChangeForFile,
  handleSaveForFile,
  reloadContent
}: {
  activeFile: OpenFile
  viewStateScopeId: string
  fileContents: Record<string, FileContent>
  editBuffers: Record<string, string>
  openFiles: OpenFile[]
  worktreeEntries: GitStatusEntry[]
  pendingEditorReveal: PendingEditorReveal | null
  getConflictNavigation: (file: OpenFile, content: string) => EditorConflictNavigation | undefined
  handleContentChangeForFile: (file: OpenFile, content: string) => void
  handleSaveForFile: (file: OpenFile, content: string) => Promise<boolean>
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  const openConflictReviewFile = useAppStore((s) => s.openConflictReviewFile)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const closeFile = useAppStore((s) => s.closeFile)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const selectedConflictReviewFile = activeFile.conflictReview?.selectedFileId
    ? (openFiles.find((file) => file.id === activeFile.conflictReview?.selectedFileId) ?? null)
    : null

  const openConflictEntry = React.useCallback(
    (entry: GitStatusEntry) => {
      openConflictReviewFile(
        activeFile.id,
        activeFile.worktreeId,
        activeFile.filePath,
        entry,
        detectLanguage(entry.path)
      )
    },
    [activeFile.filePath, activeFile.id, activeFile.worktreeId, openConflictReviewFile]
  )

  const createContentFile = (entry: GitStatusEntry): OpenFile => {
    const absolutePath = joinPath(activeFile.filePath, entry.path)
    const conflict =
      entry.conflictKind && entry.conflictStatus && entry.conflictStatusSource
        ? entry.status === 'deleted'
          ? {
              kind: 'conflict-placeholder' as const,
              conflictKind: entry.conflictKind,
              conflictStatus: entry.conflictStatus,
              conflictStatusSource: entry.conflictStatusSource,
              message: translate(
                'auto.components.editor.EditorContent.8b1a605bae',
                'This file is in a conflict state, but no working-tree file is available to edit.'
              ),
              guidance: 'Resolve the conflict in Git or restore one side before reopening it.'
            }
          : {
              kind: 'conflict-editable' as const,
              conflictKind: entry.conflictKind,
              conflictStatus: entry.conflictStatus,
              conflictStatusSource: entry.conflictStatusSource
            }
        : undefined

    return {
      id: absolutePath,
      filePath: absolutePath,
      relativePath: entry.path,
      worktreeId: activeFile.worktreeId,
      language: detectLanguage(entry.path),
      isDirty: false,
      mode: 'edit',
      conflict
    }
  }

  const renderEditorContent = ({
    contentFile,
    entry,
    className,
    viewStateKeySuffix,
    readOnly = false,
    autoHeight = false
  }: {
    contentFile: OpenFile
    entry: GitStatusEntry | null
    className: string
    viewStateKeySuffix: string
    readOnly?: boolean
    autoHeight?: boolean
  }): React.JSX.Element => {
    if (contentFile.conflict?.kind === 'conflict-placeholder') {
      return (
        <div className={className}>
          <ConflictPlaceholderView file={contentFile} />
        </div>
      )
    }

    const fileContent = fileContents[contentFile.id]
    if (!fileContent) {
      return (
        <div className={className}>
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {translate('auto.components.editor.EditorContent.b2735221f5', 'Loading...')}
          </div>
        </div>
      )
    }
    if (fileContent.loadError) {
      return (
        <div className={className}>
          <EditorFileLoadErrorView
            message={fileContent.loadError}
            onRetry={() => reloadContent(contentFile)}
          />
        </div>
      )
    }
    if (fileContent.isBinary) {
      if (fileContent.isImage) {
        return (
          <div className={className}>
            <ImageViewer
              content={fileContent.content}
              filePath={contentFile.filePath}
              mimeType={fileContent.mimeType}
            />
          </div>
        )
      }
      return (
        <div className={className}>
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {translate(
              'auto.components.editor.EditorContent.b9de81ba52',
              'Binary file — cannot display'
            )}
          </div>
        </div>
      )
    }

    const selectedLanguage = detectLanguage(contentFile.relativePath)
    const monacoLanguage = selectedLanguage === 'notebook' ? 'json' : selectedLanguage
    const selectedViewStateKey = `${contentFile.filePath}::${viewStateScopeId}:${viewStateKeySuffix}`
    const selectedContent = editBuffers[contentFile.id] ?? fileContent.content

    return (
      <div className={className}>
        {contentFile.conflict && (
          <ConflictBanner
            file={contentFile}
            entry={entry}
            conflictNavigation={getConflictNavigation(contentFile, selectedContent)}
          />
        )}
        <div className={autoHeight ? 'shrink-0' : 'min-h-0 flex-1'}>
          <MonacoEditor
            key={`${viewStateScopeId}:${contentFile.id}:${viewStateKeySuffix}`}
            fileId={contentFile.id}
            filePath={contentFile.filePath}
            viewStateKey={selectedViewStateKey}
            relativePath={contentFile.relativePath}
            content={selectedContent}
            language={monacoLanguage}
            onContentChange={
              readOnly ? () => {} : (content) => handleContentChangeForFile(contentFile, content)
            }
            onSave={readOnly ? () => {} : (content) => handleSaveForFile(contentFile, content)}
            worktreeId={contentFile.worktreeId}
            markdownAnnotationsEnabled={false}
            conflictDecorationsEnabled={contentFile.conflict?.conflictStatus === 'unresolved'}
            readOnly={readOnly}
            autoHeight={autoHeight}
            revealLine={
              matchesPendingEditorReveal(pendingEditorReveal, contentFile)
                ? pendingEditorReveal.line
                : undefined
            }
            revealColumn={
              matchesPendingEditorReveal(pendingEditorReveal, contentFile)
                ? pendingEditorReveal.column
                : undefined
            }
            revealMatchLength={
              matchesPendingEditorReveal(pendingEditorReveal, contentFile)
                ? pendingEditorReveal.matchLength
                : undefined
            }
          />
        </div>
      </div>
    )
  }

  const renderSelectedContent = (selectedFile: OpenFile): React.JSX.Element => {
    const selectedConflictEntry =
      worktreeEntries.find((entry) => entry.path === selectedFile.relativePath) ?? null
    return renderEditorContent({
      contentFile: selectedFile,
      entry: selectedConflictEntry,
      className: 'flex min-h-0 flex-1 flex-col',
      viewStateKeySuffix: 'selected'
    })
  }

  const renderInlineFile = (entry: GitStatusEntry): React.JSX.Element =>
    renderEditorContent({
      contentFile: createContentFile(entry),
      entry,
      className: 'flex min-h-[120px] flex-col border-b border-border last:border-b-0',
      viewStateKeySuffix: `overview:${entry.path}`,
      readOnly: true,
      autoHeight: true
    })

  const renderAllContent = (): React.JSX.Element => {
    const snapshotEntries = activeFile.conflictReview?.entries ?? []
    const liveEntriesByPath = new Map(worktreeEntries.map((entry) => [entry.path, entry]))
    const unresolvedEntries = snapshotEntries.flatMap((entry) => {
      const liveEntry = liveEntriesByPath.get(entry.path)
      return liveEntry?.conflictStatus === 'unresolved' && liveEntry.conflictKind ? [liveEntry] : []
    })
    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-editor-surface scrollbar-sleek">
        {unresolvedEntries.map(renderInlineFile)}
      </div>
    )
  }

  return (
    <ConflictReviewPanel
      file={activeFile}
      liveEntries={worktreeEntries}
      onOpenEntry={openConflictEntry}
      selectedFile={selectedConflictReviewFile}
      selectedContent={
        selectedConflictReviewFile
          ? renderSelectedContent(selectedConflictReviewFile)
          : renderAllContent()
      }
      onDismiss={() => closeFile(activeFile.id)}
      onRefreshSnapshot={() =>
        openConflictReview(
          activeFile.worktreeId,
          activeFile.filePath,
          worktreeEntries
            .filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind)
            .map((entry) => ({ path: entry.path, conflictKind: entry.conflictKind! })),
          'live-summary'
        )
      }
      onReturnToSourceControl={() => setRightSidebarTab('source-control')}
    />
  )
}

function matchesPendingEditorReveal(
  reveal: PendingEditorReveal | null,
  file: Pick<OpenFile, 'id' | 'filePath'>
): reveal is PendingEditorReveal {
  if (!reveal) {
    return false
  }
  return reveal.fileId ? reveal.fileId === file.id : reveal.filePath === file.filePath
}
