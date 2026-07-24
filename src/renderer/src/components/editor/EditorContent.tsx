/* eslint-disable max-lines -- Why: dispatch surface for every editor mode; keeping the mode-selection branches colocated beats scattering the switch across per-mode wrappers. */
import React from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { ChangesModeView } from './ChangesModeView'
import {
  ConflictBanner,
  ConflictPlaceholderView,
  ConflictReviewPanel,
  getNextConflictNavigationIndex
} from './ConflictComponents'
import type { MarkdownViewMode, OpenFile, PendingEditorReveal } from '@/store/slices/editor'
import type { GitStatusEntry, GitDiffResult } from '../../../../shared/types'
import { getMarkdownRenderMode } from './markdown-render-mode'
import { getMarkdownRichModeUnsupportedMessage } from './markdown-rich-mode'
import { exceedsMarkdownRichModeSizeLimit } from './markdown-rich-size-limit'
import { extractFrontMatter, prependFrontMatter } from './markdown-frontmatter'
import { RichMarkdownErrorBoundary } from './RichMarkdownErrorBoundary'
import { useMarkdownDocuments } from './useMarkdownDocuments'
import {
  findGitConflictBlocks,
  getGitConflictMarkerLineLength
} from './monaco-conflict-decorations'
import { getDiffContentSignature } from './diff-content-signature'
import { translate } from '@/i18n/i18n'
import { CheckRunDetailsPanel } from './CheckRunDetailsPanel'
import { ExternalFileChangeBanner } from './ExternalFileChangeBanner'

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

// Why: module-level for a stable no-op identity so read-only tabs don't rebuild callbacks each render.
const noopEditorContentChange = (_content: string): void => {}
const noopEditorSave = async (_content: string): Promise<boolean> => false

export function getMarkdownSourceLineOffset(frontMatterRaw: string): number {
  let offset = 0

  for (let index = 0; index < frontMatterRaw.length; index++) {
    const code = frontMatterRaw.charCodeAt(index)

    if (code === 13) {
      offset++
      if (frontMatterRaw.charCodeAt(index + 1) === 10) {
        index++
      }
      continue
    }

    if (code === 10) {
      offset++
    }
  }

  return offset
}

type FileContent = {
  content: string
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  loadError?: string
}

const noopCloseMarkdownTableOfContents = (): void => {}

function matchesPendingEditorReveal(
  reveal: PendingEditorReveal | null,
  file: Pick<OpenFile, 'id' | 'filePath'>
): reveal is PendingEditorReveal {
  if (!reveal) {
    return false
  }
  return reveal.fileId ? reveal.fileId === file.id : reveal.filePath === file.filePath
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
          <div className="font-medium text-foreground">
            {translate('auto.components.editor.EditorContent.39f018b052', 'Unable to load file')}
          </div>
          <div className="mt-1 break-words">{message}</div>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            {translate('auto.components.editor.EditorContent.2a512bb46a', 'Retry')}
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
  openFiles,
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
  showMarkdownFrontmatter = false,
  onCloseMarkdownTableOfContents = noopCloseMarkdownTableOfContents,
  markdownAnnotationsEnabled = true,
  pendingEditorReveal,
  handleContentChange,
  handleContentChangeForFile,
  handleDirtyStateHint,
  handleSave,
  handleSaveForFile,
  reloadContent
}: {
  activeFile: OpenFile
  viewStateScopeId: string
  fileContents: Record<string, FileContent>
  diffContents: Record<string, GitDiffResult>
  editBuffers: Record<string, string>
  openFiles: OpenFile[]
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
  showMarkdownFrontmatter?: boolean
  onCloseMarkdownTableOfContents?: () => void
  markdownAnnotationsEnabled?: boolean
  pendingEditorReveal: PendingEditorReveal | null
  handleContentChange: (content: string) => void
  handleContentChangeForFile: (file: OpenFile, content: string) => void
  handleDirtyStateHint: (dirty: boolean) => void
  handleSave: (content: string) => Promise<boolean>
  handleSaveForFile: (file: OpenFile, content: string) => Promise<boolean>
  reloadContent: (file: OpenFile) => void
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

  const openConflictReviewFile = useAppStore((s) => s.openConflictReviewFile)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const closeFile = useAppStore((s) => s.closeFile)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const reloadOpenCheckRunDetailsTab = useAppStore((s) => s.reloadOpenCheckRunDetailsTab)
  const [conflictNavigationIndexByFile, setConflictNavigationIndexByFile] = React.useState<
    Record<string, number>
  >({})
  const md = useMarkdownDocuments(activeFile, isMarkdown, mdViewMode, handleSave)
  const activeConflictEntry =
    worktreeEntries.find((entry) => entry.path === activeFile.relativePath) ?? null
  const selectedConflictReviewFile =
    activeFile.mode === 'conflict-review' && activeFile.conflictReview?.selectedFileId
      ? (openFiles.find((file) => file.id === activeFile.conflictReview?.selectedFileId) ?? null)
      : null

  const isCombinedDiff =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'combined-all' ||
      activeFile.diffSource === 'combined-uncommitted' ||
      activeFile.diffSource === 'combined-branch' ||
      activeFile.diffSource === 'combined-commit')

  const getConflictNavigation = React.useCallback(
    (file: OpenFile, content: string) => {
      const blocks = findGitConflictBlocks(content)
      if (blocks.length === 0) {
        return undefined
      }

      const currentIndex = conflictNavigationIndexByFile[file.id] ?? null
      return {
        currentIndex,
        total: blocks.length,
        onJump: (direction: 'previous' | 'next') => {
          const nextIndex = getNextConflictNavigationIndex({
            currentIndex,
            direction,
            total: blocks.length
          })
          if (nextIndex === null) {
            return
          }
          const line = blocks[nextIndex].startLine
          const markerLineLength = getGitConflictMarkerLineLength(content, line)
          setConflictNavigationIndexByFile((prev) => ({ ...prev, [file.id]: nextIndex }))
          // Why: clear first so a repeated same-location reveal still changes the prop and re-runs the editor's reveal effect.
          setPendingEditorReveal(null)
          queueMicrotask(() => {
            setPendingEditorReveal({
              filePath: file.filePath,
              line,
              column: 1,
              matchLength: markerLineLength
            })
          })
        }
      }
    },
    [conflictNavigationIndexByFile, setPendingEditorReveal]
  )
  const openConflictEntry = React.useCallback(
    (entry: GitStatusEntry) => {
      if (activeFile.mode !== 'conflict-review') {
        return
      }
      openConflictReviewFile(
        activeFile.id,
        activeFile.worktreeId,
        activeFile.filePath,
        entry,
        detectLanguage(entry.path)
      )
    },
    [
      activeFile.filePath,
      activeFile.id,
      activeFile.mode,
      activeFile.worktreeId,
      openConflictReviewFile
    ]
  )

  const createConflictReviewContentFile = (entry: GitStatusEntry): OpenFile => {
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

  const renderMonacoEditor = (fc: FileContent): React.JSX.Element => (
    // Why: without a key React reuses the instance and skips cleanup (scroll snapshot); key forces a remount per pane+path.
    <MonacoEditor
      key={`${viewStateScopeId}\u0000${activeFile.filePath}`}
      fileId={activeFile.id}
      filePath={activeFile.filePath}
      viewStateKey={editorViewStateKey}
      relativePath={activeFile.relativePath}
      content={editBuffers[activeFile.id] ?? fc.content}
      language={monacoLanguage}
      // Why: read-only tabs no-op the change/save callbacks so no draft, dirty state, or write can occur.
      readOnly={activeFile.readOnly === true}
      liveTail={activeFile.liveTail === true}
      onContentChange={activeFile.readOnly === true ? noopEditorContentChange : handleContentChange}
      onSave={activeFile.readOnly === true ? noopEditorSave : isMarkdown ? md.mdSave : handleSave}
      worktreeId={activeFile.worktreeId}
      markdownAnnotationsEnabled={markdownAnnotationsEnabled && isMarkdown}
      conflictDecorationsEnabled={activeFile.conflict?.conflictStatus === 'unresolved'}
      revealLine={
        matchesPendingEditorReveal(pendingEditorReveal, activeFile)
          ? pendingEditorReveal.line
          : undefined
      }
      revealColumn={
        matchesPendingEditorReveal(pendingEditorReveal, activeFile)
          ? pendingEditorReveal.column
          : undefined
      }
      revealMatchLength={
        matchesPendingEditorReveal(pendingEditorReveal, activeFile)
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
      exceedsRichModeSizeLimit: exceedsMarkdownRichModeSizeLimit(currentContent),
      hasRichModeUnsupportedContent: richModeUnsupportedMessage !== null,
      viewMode: mdViewMode
    })

    if (activeFile.conflict?.conflictStatus === 'unresolved') {
      // Why: rich/preview modes hide the conflict-marker source text the user must edit directly.
      return <div className="h-full min-h-0">{renderMonacoEditor(fc)}</div>
    }

    // Why: banner explains why the "rich" view is showing Monaco source (size forced a source-mode fallback).
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
      // Why: Tiptap has no front-matter node and would drop it, so strip it here and recombine on change/save.
      const fm = extractFrontMatter(currentContent)
      const editorContent = fm ? fm.body : currentContent

      const onContentChangeWithFm = fm
        ? (body: string): void => handleContentChange(prependFrontMatter(fm.raw, body))
        : handleContentChange

      const onSaveWithFm = fm
        ? (body: string): Promise<boolean> => md.mdSave(prependFrontMatter(fm.raw, body))
        : md.mdSave

      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1">
            {/* Why: keyed for remount like MonacoEditor; boundary contains a TipTap render crash (issue #826) to this pane. */}
            <RichMarkdownErrorBoundary key={viewStateScopeId} fileId={activeFile.id}>
              <RichMarkdownEditor
                fileId={activeFile.id}
                content={editorContent}
                filePath={activeFile.filePath}
                worktreeId={activeFile.worktreeId}
                runtimeEnvironmentId={activeFile.runtimeEnvironmentId}
                scrollCacheKey={`${editorViewStateKey}:rich`}
                onContentChange={onContentChangeWithFm}
                onDirtyStateHint={handleDirtyStateHint}
                onSave={onSaveWithFm}
                onOpenDocLink={md.onOpenDocLink}
                markdownDocuments={md.markdownDocuments}
                showTableOfContents={showMarkdownTableOfContents}
                onCloseTableOfContents={onCloseMarkdownTableOfContents}
                markdownAnnotationsEnabled={markdownAnnotationsEnabled}
                markdownAnnotationFilePath={activeFile.relativePath}
                markdownSourceLineOffset={fm ? getMarkdownSourceLineOffset(fm.raw) : 0}
                markdownReviewContent={currentContent}
                // Why: banner goes below the toolbar (inside the editor shell) so formatting controls stay at the top of the pane.
                headerSlot={
                  fm && showMarkdownFrontmatter ? <FrontMatterBanner raw={fm.raw} /> : null
                }
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
          {/* Why: fall back to the stable preview renderer when Tiptap can't safely own the document. */}
          <div className="min-h-0 flex-1">
            <MarkdownPreview
              key={viewStateScopeId}
              content={currentContent}
              filePath={activeFile.filePath}
              sourceFileId={activeFile.id}
              sourceWorktreeId={activeFile.worktreeId}
              sourceRuntimeEnvironmentId={activeFile.runtimeEnvironmentId}
              scrollCacheKey={`${editorViewStateKey}:preview`}
              showTableOfContents={showMarkdownTableOfContents}
              onCloseTableOfContents={onCloseMarkdownTableOfContents}
              markdownAnnotationsEnabled={markdownAnnotationsEnabled}
              {...md.previewProps}
            />
          </div>
        </div>
      )
    }

    // Why: Monaco with height="100%" sizes to its immediate parent, so the wrapper needs an explicit height or it collapses.
    return <div className="h-full min-h-0">{renderMonacoEditor(fc)}</div>
  }

  const renderConflictReviewEditorContent = ({
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

    const fc = fileContents[contentFile.id]
    if (!fc) {
      return (
        <div className={className}>
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {translate('auto.components.editor.EditorContent.b2735221f5', 'Loading...')}
          </div>
        </div>
      )
    }
    if (fc.loadError) {
      return (
        <div className={className}>
          <FileLoadErrorView message={fc.loadError} onRetry={() => reloadContent(contentFile)} />
        </div>
      )
    }
    if (fc.isBinary) {
      if (fc.isImage) {
        return (
          <div className={className}>
            <ImageViewer
              content={fc.content}
              filePath={contentFile.filePath}
              mimeType={fc.mimeType}
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
    const monacoSelectedLanguage = selectedLanguage === 'notebook' ? 'json' : selectedLanguage
    const selectedViewStateKey = `${contentFile.filePath}::${viewStateScopeId}:${viewStateKeySuffix}`
    const selectedContent = editBuffers[contentFile.id] ?? fc.content

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
            language={monacoSelectedLanguage}
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

  const renderConflictReviewSelectedContent = (selectedFile: OpenFile): React.JSX.Element => {
    const selectedConflictEntry =
      worktreeEntries.find((entry) => entry.path === selectedFile.relativePath) ?? null

    return renderConflictReviewEditorContent({
      contentFile: selectedFile,
      entry: selectedConflictEntry,
      className: 'flex min-h-0 flex-1 flex-col',
      viewStateKeySuffix: 'selected'
    })
  }

  const renderConflictReviewInlineFile = (entry: GitStatusEntry): React.JSX.Element => {
    const contentFile = createConflictReviewContentFile(entry)

    return renderConflictReviewEditorContent({
      contentFile,
      entry,
      className: 'flex min-h-[120px] flex-col border-b border-border last:border-b-0',
      viewStateKeySuffix: `overview:${entry.path}`,
      readOnly: true,
      autoHeight: true
    })
  }

  const renderConflictReviewAllContent = (): React.JSX.Element => {
    const snapshotEntries = activeFile.conflictReview?.entries ?? []
    const liveEntriesByPath = new Map(worktreeEntries.map((entry) => [entry.path, entry]))
    const unresolvedEntries = snapshotEntries.flatMap((entry) => {
      const liveEntry = liveEntriesByPath.get(entry.path)
      return liveEntry?.conflictStatus === 'unresolved' && liveEntry.conflictKind ? [liveEntry] : []
    })

    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-editor-surface scrollbar-sleek">
        {unresolvedEntries.map(renderConflictReviewInlineFile)}
      </div>
    )
  }

  if (activeFile.mode === 'check-details') {
    const checkRunDetails = activeFile.checkRunDetails
    if (!checkRunDetails) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {translate(
            'auto.components.editor.EditorContent.6c4f1a8d2e',
            'Check details are unavailable.'
          )}
        </div>
      )
    }
    const details = checkRunDetails.details
    const openUrl = details?.detailsUrl ?? details?.url ?? checkRunDetails.check.url
    return (
      <CheckRunDetailsPanel
        check={checkRunDetails.check}
        details={checkRunDetails.details}
        loading={checkRunDetails.loading}
        error={checkRunDetails.error}
        openUrl={openUrl}
        worktreeId={activeFile.worktreeId}
        onRefresh={() => {
          void reloadOpenCheckRunDetailsTab(activeFile.id)
        }}
      />
    )
  }

  if (activeFile.mode === 'conflict-review') {
    return (
      <ConflictReviewPanel
        file={activeFile}
        liveEntries={worktreeEntries}
        onOpenEntry={openConflictEntry}
        selectedFile={selectedConflictReviewFile}
        selectedContent={
          selectedConflictReviewFile
            ? renderConflictReviewSelectedContent(selectedConflictReviewFile)
            : renderConflictReviewAllContent()
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
          {translate('auto.components.editor.EditorContent.37a0e81fa6', 'Loading preview...')}
        </div>
      )
    }
    if (fc.loadError) {
      return <FileLoadErrorView message={fc.loadError} onRetry={() => reloadContent(activeFile)} />
    }
    if (fc.isBinary) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
          {translate(
            'auto.components.editor.EditorContent.8608ce4cb1',
            'Markdown preview is unavailable for binary files.'
          )}
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
          sourceFileId={previewSourceFileId}
          sourceWorktreeId={activeFile.worktreeId}
          sourceRuntimeEnvironmentId={activeFile.runtimeEnvironmentId}
          scrollCacheKey={markdownPreviewViewStateKey}
          initialAnchor={activeFile.markdownPreviewAnchor ?? null}
          showTableOfContents={showMarkdownTableOfContents}
          onCloseTableOfContents={onCloseMarkdownTableOfContents}
          markdownAnnotationsEnabled={markdownAnnotationsEnabled}
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
          {translate('auto.components.editor.EditorContent.b2735221f5', 'Loading...')}
        </div>
      )
    }
    if (fc.loadError) {
      return <FileLoadErrorView message={fc.loadError} onRetry={() => reloadContent(activeFile)} />
    }
    if (fc.isBinary) {
      if (fc.isImage) {
        return (
          <ImageViewer content={fc.content} filePath={activeFile.filePath} mimeType={fc.mimeType} />
        )
      }
      return (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          {translate(
            'auto.components.editor.EditorContent.b9de81ba52',
            'Binary file — cannot display'
          )}
        </div>
      )
    }
    const externalChangeBanner =
      activeFile.externalMutation === 'changed' ? (
        <ExternalFileChangeBanner
          file={activeFile}
          currentContent={editBuffers[activeFile.id] ?? fc.content}
          reloadContent={reloadContent}
        />
      ) : null
    if (isChangesMode) {
      const changesView = (
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
      if (!externalChangeBanner) {
        return changesView
      }
      return (
        <div className="flex flex-1 min-h-0 flex-col">
          {externalChangeBanner}
          <div className="min-h-0 flex-1">{changesView}</div>
        </div>
      )
    }
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {externalChangeBanner}
        {activeFile.conflict && (
          <ConflictBanner
            file={activeFile}
            entry={activeConflictEntry}
            conflictNavigation={getConflictNavigation(
              activeFile,
              editBuffers[activeFile.id] ?? fc.content
            )}
          />
        )}
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
        {translate('auto.components.editor.EditorContent.c88c73a0d3', 'Loading diff...')}
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
          <div className="text-sm font-medium text-foreground">
            {translate('auto.components.editor.EditorContent.78541e254e', 'Binary file changed')}
          </div>
          <div className="text-xs text-muted-foreground">
            {activeFile.diffSource === 'branch'
              ? translate(
                  'auto.components.editor.EditorContent.3c6e71df22',
                  'Text diff is unavailable for this file in branch compare.'
                )
              : translate(
                  'auto.components.editor.EditorContent.8a0898ae4c',
                  'Text diff is unavailable for this file.'
                )}
          </div>
        </div>
      </div>
    )
  }
  const modifiedDiffBuffer = editBuffers[activeFile.id]
  const modifiedDiffContent = modifiedDiffBuffer ?? dc.modifiedContent
  const largeDiffSaveContentAvailable = !(
    dc.largeDiffRenderLimit?.limited === true &&
    modifiedDiffBuffer === undefined &&
    dc.modifiedContent.length === 0
  )
  // Why: shared by both diff sub-branches (preview and source) so preview mode surfaces the external change too.
  const diffExternalChangeBanner =
    activeFile.externalMutation === 'changed' ? (
      <ExternalFileChangeBanner
        file={activeFile}
        currentContent={modifiedDiffContent}
        reloadContent={reloadContent}
      />
    ) : null
  if (isMarkdown && mdViewMode === 'preview' && dc.largeDiffRenderLimit?.limited !== true) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {diffExternalChangeBanner}
        <div className="border-b border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {/* Why: markdown preview can't show additions and deletions at once, so it shows only the modified side. */}
          {translate(
            'auto.components.editor.EditorContent.9640d1d3db',
            'Previewing the modified version of this diff. Switch to source mode to inspect changes.'
          )}
        </div>
        <div className="min-h-0 flex-1">
          <MarkdownPreview
            key={viewStateScopeId}
            content={modifiedDiffContent}
            filePath={activeFile.filePath}
            sourceFileId={activeFile.id}
            sourceWorktreeId={activeFile.worktreeId}
            sourceRuntimeEnvironmentId={activeFile.runtimeEnvironmentId}
            scrollCacheKey={`${diffViewStateKey}:preview`}
            showTableOfContents={showMarkdownTableOfContents}
            onCloseTableOfContents={onCloseMarkdownTableOfContents}
            markdownAnnotationsEnabled={markdownAnnotationsEnabled}
            {...md.previewProps}
          />
        </div>
      </div>
    )
  }
  // Why: key off fetched diff content + reload nonce (not the edit buffer) so Monaco reloads refreshed blobs but keeps undo.
  const diffReloadNonce = activeFile.diffContentReloadNonce ?? 0
  const originalModelKey = `${diffViewStateKey}:original:${getDiffContentSignature(dc.originalContent)}`
  const modifiedModelKey = `${diffViewStateKey}:modified:${getDiffContentSignature(dc.modifiedContent)}:${diffReloadNonce}`
  const diffViewer = (
    <DiffViewer
      // Why: content refreshes via modifiedModelKey; keying off content too would remount Monaco and flash on every save.
      key={`${viewStateScopeId}:${diffReloadNonce}`}
      modelKey={diffViewStateKey}
      originalModelKey={originalModelKey}
      modifiedModelKey={modifiedModelKey}
      originalContent={dc.originalContent}
      modifiedContent={modifiedDiffContent}
      largeDiffRenderLimit={dc.largeDiffRenderLimit}
      largeDiffSaveContentAvailable={largeDiffSaveContentAvailable}
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
  // Why: editable diffs get the changed-on-disk banner; its reload refetches the diff body, not plain file content.
  if (activeFile.externalMutation !== 'changed') {
    return diffViewer
  }
  return (
    // Why: parent isn't a flex container, so flex-1 collapses to 0px — use h-full here and a flex column inside.
    <div className="flex h-full min-h-0 flex-col">
      {diffExternalChangeBanner}
      <div className="flex min-h-0 flex-1 flex-col">{diffViewer}</div>
    </div>
  )
}

// Why: no collapsible state — layout shifts would interfere with ProseMirror's scroll management.
function FrontMatterBanner({ raw }: { raw: string }): React.JSX.Element {
  // Strip the opening/closing delimiters to show only the YAML/TOML content.
  const inner = raw
    .replace(/^(?:---|\+\+\+)\r?\n/, '')
    .replace(/\r?\n(?:---|\+\+\+)\r?\n?$/, '')
    .trim()

  return (
    <div className="border-b border-border/60 bg-muted/40 px-3 py-2">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {translate('auto.components.editor.EditorContent.e4b074749d', 'Front Matter')}
        <span className="ml-2 font-normal normal-case tracking-normal opacity-70">
          {translate('auto.components.editor.EditorContent.56dba34e1a', '(edit in source mode)')}
        </span>
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono scrollbar-editor">
        {inner}
      </pre>
    </div>
  )
}
