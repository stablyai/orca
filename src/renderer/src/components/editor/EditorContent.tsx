/* eslint-disable max-lines -- Why: EditorContent is the dispatch surface for
every editor mode (edit, diff, conflict, markdown-preview, combined-diff, and
now Changes view mode). Keeping the mode-selection branches colocated is easier
to reason about than scattering the switch across per-mode wrappers. Individual
renderers (MonacoEditor, DiffViewer, ChangesModeView, MarkdownPreview, etc.)
already live in their own modules. */
import React, { lazy } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { detectLanguage } from '@/lib/language-detect'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { ChangesModeView } from './ChangesModeView'
import { ConflictBanner, ConflictPlaceholderView, ConflictReviewPanel } from './ConflictComponents'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import type { GitStatusEntry, GitDiffResult } from '../../../../shared/types'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import { getMarkdownRenderMode } from './markdown-render-mode'
import { getMarkdownRichModeUnsupportedMessage } from './markdown-rich-mode'
import { extractFrontMatter, prependFrontMatter } from './markdown-frontmatter'
import { RichMarkdownErrorBoundary } from './RichMarkdownErrorBoundary'
import { useMarkdownDocuments } from './useMarkdownDocuments'

const MonacoEditor = lazy(() => import('./MonacoEditor'))
const DiffViewer = lazy(() => import('./DiffViewer'))
const CombinedDiffViewer = lazy(() => import('./CombinedDiffViewer'))
const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor'))
const MarkdownPreview = lazy(() => import('./MarkdownPreview'))
const ImageViewer = lazy(() => import('./ImageViewer'))
const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))
const MermaidViewer = lazy(() => import('./MermaidViewer'))
const CsvViewer = lazy(() => import('./CsvViewer'))
const IpynbViewer = lazy(() => import('./IpynbViewer'))

const richMarkdownSizeEncoder = new TextEncoder()
// Why: encodeInto() with a pre-allocated buffer avoids creating a new
// Uint8Array on every render, reducing GC pressure for large files.
const richMarkdownSizeBuffer = new Uint8Array(RICH_MARKDOWN_MAX_SIZE_BYTES + 1)

type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  loadError?: string
}

function FileLoadErrorView({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
      <div className="flex max-w-xl items-start gap-3 rounded-md border border-border bg-background p-4">
        <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-foreground">Unable to load file</div>
          <div className="mt-1 break-words">{message}</div>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </div>
      </div>
    </div>
  )
}

export function EditorContent({
  activeFile,
  viewStateScopeId,
  fileContents,
  diffContents,
  editBuffers,
  worktreeEntries,
  resolvedLanguage,
  isMarkdown,
  isMermaid,
  isCsv,
  isNotebook,
  mdViewMode,
  isChangesMode,
  sideBySide,
  showMarkdownTableOfContents = false,
  onCloseMarkdownTableOfContents = () => {},
  pendingEditorReveal,
  handleContentChange,
  handleDirtyStateHint,
  handleSave,
  reloadFileContent
}: {
  activeFile: OpenFile
  viewStateScopeId: string
  fileContents: Record<string, FileContent>
  diffContents: Record<string, GitDiffResult>
  editBuffers: Record<string, string>
  worktreeEntries: GitStatusEntry[]
  resolvedLanguage: string
  isMarkdown: boolean
  isMermaid: boolean
  isCsv: boolean
  isNotebook: boolean
  mdViewMode: MarkdownViewMode
  isChangesMode: boolean
  sideBySide: boolean
  showMarkdownTableOfContents?: boolean
  onCloseMarkdownTableOfContents?: () => void
  pendingEditorReveal: {
    filePath?: string
    line?: number
    column?: number
    matchLength?: number
  } | null
  handleContentChange: (content: string) => void
  handleDirtyStateHint: (dirty: boolean) => void
  handleSave: (content: string) => Promise<void>
  reloadFileContent: (file: OpenFile) => void
}): React.JSX.Element {
  const editorViewStateKey =
    viewStateScopeId === activeFile.id
      ? activeFile.filePath
      : `${activeFile.filePath}::${viewStateScopeId}`
  const diffViewStateKey =
    viewStateScopeId === activeFile.id ? activeFile.id : `${activeFile.id}::${viewStateScopeId}`
  const markdownPreviewViewStateKey =
    viewStateScopeId === activeFile.id
      ? `${activeFile.id}:preview`
      : `${activeFile.id}::${viewStateScopeId}:preview`
  const monacoLanguage = resolvedLanguage === 'notebook' ? 'json' : resolvedLanguage

  const openConflictFile = useAppStore((s) => s.openConflictFile)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const closeFile = useAppStore((s) => s.closeFile)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const md = useMarkdownDocuments(activeFile, isMarkdown, mdViewMode, handleSave)
  const activeConflictEntry =
    worktreeEntries.find((entry) => entry.path === activeFile.relativePath) ?? null

  const isCombinedDiff =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'combined-uncommitted' ||
      activeFile.diffSource === 'combined-branch')

  const renderMonacoEditor = (fc: FileContent): React.JSX.Element => (
    // Why: Without a key, React reuses the same MonacoEditor instance when
    // switching tabs or split panes, just updating props. That means
    // useLayoutEffect cleanup (which snapshots scroll position) never fires.
    // Keying on the visible pane identity forces unmount/remount so each split
    // tab keeps its own viewport state even when the underlying file is shared.
    <MonacoEditor
      key={viewStateScopeId}
      filePath={activeFile.filePath}
      viewStateKey={editorViewStateKey}
      relativePath={activeFile.relativePath}
      content={editBuffers[activeFile.id] ?? fc.content}
      language={monacoLanguage}
      onContentChange={handleContentChange}
      onSave={isMarkdown ? md.mdSave : handleSave}
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
      markdownDocuments={isMarkdown ? md.markdownDocuments : undefined}
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
      const richFallbackMessage =
        richModeUnsupportedMessage ??
        'File is too large for rich editing. Showing source mode instead.'
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="border-b border-border/60 bg-blue-500/10 px-3 py-2 text-xs text-blue-950 dark:text-blue-100">
            {richFallbackMessage}
          </div>
          <div className="min-h-0 flex-1 h-full">{renderMonacoEditor(fc)}</div>
        </div>
      )
    }

    if (renderMode === 'rich-editor') {
      // Why: front-matter is stripped before the rich editor sees the content
      // because Tiptap has no front-matter node and would silently drop it.
      // The raw block is displayed as a read-only banner and recombined with
      // the body on every content change and save so the edit buffer always
      // holds the complete document.
      const fm = extractFrontMatter(currentContent)
      const editorContent = fm ? fm.body : currentContent

      const onContentChangeWithFm = fm
        ? (body: string): void => handleContentChange(prependFrontMatter(fm.raw, body))
        : handleContentChange

      const onSaveWithFm = fm
        ? (body: string): Promise<void> => md.mdSave(prependFrontMatter(fm.raw, body))
        : md.mdSave

      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            {/* Why: same remount reasoning as MonacoEditor — see renderMonacoEditor.
                The boundary contains a TipTap/ProseMirror render crash (e.g.
                when a setContent transaction throws under split-pane external
                reload, issue #826) to this pane instead of letting it tear down
                the whole renderer tree. */}
            <RichMarkdownErrorBoundary key={viewStateScopeId} fileId={activeFile.id}>
              <RichMarkdownEditor
                fileId={activeFile.id}
                content={editorContent}
                filePath={activeFile.filePath}
                worktreeId={activeFile.worktreeId}
                scrollCacheKey={`${editorViewStateKey}:rich`}
                onContentChange={onContentChangeWithFm}
                onDirtyStateHint={handleDirtyStateHint}
                onSave={onSaveWithFm}
                onOpenDocLink={md.onOpenDocLink}
                markdownDocuments={md.markdownDocuments}
                showTableOfContents={showMarkdownTableOfContents}
                onCloseTableOfContents={onCloseMarkdownTableOfContents}
                // Why: render the front-matter banner below the editor toolbar
                // (inside the editor shell) so formatting controls remain at
                // the top of the pane — the banner is read-only context, not
                // a header above the toolbar.
                headerSlot={fm ? <FrontMatterBanner raw={fm.raw} /> : null}
              />
            </RichMarkdownErrorBoundary>
          </div>
        </div>
      )
    }

    if (renderMode === 'preview') {
      const shouldExplainRichFallback = mdViewMode === 'rich' && richModeUnsupportedMessage
      return (
        <div className="flex h-full min-h-0 flex-col">
          {shouldExplainRichFallback ? (
            <div className="border-b border-border/60 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
              {richModeUnsupportedMessage}
            </div>
          ) : null}
          {/* Why: before rich editing shipped, Orca already had a stable markdown
          preview surface. If Tiptap cannot safely own a document, falling back
          to that renderer preserves readable preview mode instead of forcing the
          user out of preview entirely. Source mode remains available for edits. */}
          <div className="min-h-0 flex-1">
            <MarkdownPreview
              key={viewStateScopeId}
              content={currentContent}
              filePath={activeFile.filePath}
              scrollCacheKey={`${editorViewStateKey}:preview`}
              showTableOfContents={showMarkdownTableOfContents}
              onCloseTableOfContents={onCloseMarkdownTableOfContents}
              {...md.previewProps}
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
    return (
      <CombinedDiffViewer
        key={viewStateScopeId}
        file={activeFile}
        viewStateKey={diffViewStateKey}
      />
    )
  }

  if (activeFile.mode === 'markdown-preview') {
    const fc = fileContents[activeFile.id]
    if (!fc) {
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Loading preview...
        </div>
      )
    }
    if (fc.loadError) {
      return (
        <FileLoadErrorView message={fc.loadError} onRetry={() => reloadFileContent(activeFile)} />
      )
    }
    if (fc.isBinary) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          Markdown preview is unavailable for binary files.
        </div>
      )
    }
    const previewSourceFileId = activeFile.markdownPreviewSourceFileId ?? activeFile.filePath
    const previewContent = editBuffers[previewSourceFileId] ?? fc.content
    return (
      <div className="min-h-0 flex-1">
        <MarkdownPreview
          key={viewStateScopeId}
          content={previewContent}
          filePath={activeFile.filePath}
          scrollCacheKey={markdownPreviewViewStateKey}
          initialAnchor={activeFile.markdownPreviewAnchor ?? null}
          showTableOfContents={showMarkdownTableOfContents}
          onCloseTableOfContents={onCloseMarkdownTableOfContents}
          {...md.previewProps}
        />
      </div>
    )
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
    if (fc.loadError) {
      return (
        <FileLoadErrorView message={fc.loadError} onRetry={() => reloadFileContent(activeFile)} />
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
    if (isChangesMode) {
      return (
        <ChangesModeView
          activeFile={activeFile}
          dc={diffContents[activeFile.id]}
          modifiedContent={editBuffers[activeFile.id] ?? fc.content}
          activeConflictEntry={activeConflictEntry}
          resolvedLanguage={monacoLanguage}
          sideBySide={sideBySide}
          viewStateScopeId={viewStateScopeId}
          diffViewStateKey={diffViewStateKey}
          onContentChange={handleContentChange}
          onSave={isMarkdown ? md.mdSave : handleSave}
        />
      )
    }
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {activeFile.conflict && <ConflictBanner file={activeFile} entry={activeConflictEntry} />}
        <div className="min-h-0 flex-1 relative">
          {isMarkdown ? (
            renderMarkdownContent(fc)
          ) : isMermaid && mdViewMode === 'rich' ? (
            <MermaidViewer
              key={activeFile.id}
              content={editBuffers[activeFile.id] ?? fc.content}
              filePath={activeFile.filePath}
            />
          ) : isCsv && mdViewMode === 'rich' ? (
            <CsvViewer
              key={activeFile.id}
              content={editBuffers[activeFile.id] ?? fc.content}
              filePath={activeFile.filePath}
            />
          ) : isNotebook && mdViewMode === 'rich' ? (
            <IpynbViewer
              key={activeFile.id}
              content={editBuffers[activeFile.id] ?? fc.content}
              fileId={activeFile.id}
              filePath={activeFile.filePath}
              worktreeId={activeFile.worktreeId}
              scrollCacheKey={`${editorViewStateKey}:notebook`}
              onContentChange={handleContentChange}
              onDirtyStateHint={handleDirtyStateHint}
              onSave={handleSave}
            />
          ) : (
            renderMonacoEditor(fc)
          )}
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
  const modifiedDiffContent = editBuffers[activeFile.id] ?? dc.modifiedContent
  if (isMarkdown && mdViewMode === 'preview') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {/* Why: a rendered markdown preview cannot express additions and
          deletions simultaneously, so preview mode intentionally shows the
          modified side of the diff. Source mode remains available for the
          actual line-by-line comparison. */}
          Previewing the modified version of this diff. Switch to source mode to inspect changes.
        </div>
        <div className="min-h-0 flex-1">
          <MarkdownPreview
            key={viewStateScopeId}
            content={modifiedDiffContent}
            filePath={activeFile.filePath}
            scrollCacheKey={`${diffViewStateKey}:preview`}
            showTableOfContents={showMarkdownTableOfContents}
            onCloseTableOfContents={onCloseMarkdownTableOfContents}
            {...md.previewProps}
          />
        </div>
      </div>
    )
  }
  return (
    <DiffViewer
      key={viewStateScopeId}
      modelKey={diffViewStateKey}
      originalContent={dc.originalContent}
      modifiedContent={modifiedDiffContent}
      language={monacoLanguage}
      filePath={activeFile.filePath}
      relativePath={activeFile.relativePath}
      sideBySide={sideBySide}
      editable={isEditable}
      worktreeId={activeFile.worktreeId}
      onContentChange={isEditable ? handleContentChange : undefined}
      onSave={isEditable ? (isMarkdown ? md.mdSave : handleSave) : undefined}
    />
  )
}

// Why: a minimal read-only banner that shows the raw front-matter content
// above the rich editor so the user knows it exists and can switch to source
// mode to edit it. Kept deliberately simple — no collapsible state — to avoid
// layout shifts that would interfere with ProseMirror's scroll management.
function FrontMatterBanner({ raw }: { raw: string }): React.JSX.Element {
  // Strip the opening/closing delimiters to show only the YAML/TOML content.
  const inner = raw
    .replace(/^(?:---|\+\+\+)\r?\n/, '')
    .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
    .trim()

  return (
    <div className="border-b border-border/60 bg-muted/40 px-3 py-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Front Matter
        <span className="ml-2 font-normal normal-case tracking-normal opacity-70">
          (edit in source mode)
        </span>
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono scrollbar-editor">
        {inner}
      </pre>
    </div>
  )
}
