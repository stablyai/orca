import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import { Button } from '@/components/ui/button'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import { formatBytes } from '../status-bar/workspace-space-format'
import { MarkdownPreview, RichMarkdownEditor } from './editor-lazy-views'
import { extractFrontMatter, prependFrontMatter } from './markdown-frontmatter'
import type { MarkdownRenderState } from './markdown-render-mode'
import { RichMarkdownErrorBoundary } from './RichMarkdownErrorBoundary'
import type { useMarkdownDocuments } from './useMarkdownDocuments'

type MarkdownDocumentsController = ReturnType<typeof useMarkdownDocuments>

export function EditorMarkdownFileSurface({
  activeFile,
  viewStateScopeId,
  editorViewStateKey,
  currentContent,
  mdViewMode,
  inlineMarkdownRenderState,
  showMarkdownTableOfContents,
  showMarkdownFrontmatter,
  onCloseMarkdownTableOfContents,
  markdownAnnotationsEnabled,
  markdownDocuments,
  getMarkdownSourceLineOffset,
  handleContentChange,
  handleDirtyStateHint,
  monacoEditor
}: {
  activeFile: OpenFile
  viewStateScopeId: string
  editorViewStateKey: string
  currentContent: string
  mdViewMode: MarkdownViewMode
  inlineMarkdownRenderState: MarkdownRenderState | null
  showMarkdownTableOfContents: boolean
  showMarkdownFrontmatter: boolean
  onCloseMarkdownTableOfContents: () => void
  markdownAnnotationsEnabled: boolean
  markdownDocuments: MarkdownDocumentsController
  getMarkdownSourceLineOffset: (frontMatterRaw: string) => number
  handleContentChange: (content: string) => void
  handleDirtyStateHint: (dirty: boolean) => void
  monacoEditor: React.JSX.Element
}): React.JSX.Element {
  const setSizeOverride = useAppStore((s) => s.setMarkdownRichModeSizeOverride)

  if (activeFile.conflict?.conflictStatus === 'unresolved') {
    return <div className="h-full min-h-0">{monacoEditor}</div>
  }
  if (!inlineMarkdownRenderState) {
    return <div className="h-full min-h-0">{monacoEditor}</div>
  }
  const { renderMode, richModeUnsupportedMessage } = inlineMarkdownRenderState
  if (renderMode === 'source' && mdViewMode === 'rich') {
    // Why: only a size fallback is recoverable — unsupported syntax would round-trip badly, so it gets no override.
    const isSizeFallback = richModeUnsupportedMessage === null
    const richFallbackMessage =
      richModeUnsupportedMessage ??
      translate(
        'editor.richMarkdown.tooLarge',
        'File is larger than the {{limit}} rich editing limit. Showing source mode instead.',
        { limit: formatBytes(RICH_MARKDOWN_MAX_SIZE_BYTES) }
      )
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-3 border-b border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{richFallbackMessage}</span>
          {isSizeFallback ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              onClick={() => setSizeOverride(activeFile.id, true)}
            >
              {translate('editor.richMarkdown.openAnyway', 'Open anyway')}
            </Button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 h-full">{monacoEditor}</div>
      </div>
    )
  }
  if (renderMode === 'rich-editor') {
    const frontMatter = extractFrontMatter(currentContent)
    const editorContent = frontMatter ? frontMatter.body : currentContent
    const onContentChange = frontMatter
      ? (body: string): void => handleContentChange(prependFrontMatter(frontMatter.raw, body))
      : handleContentChange
    const onSave = frontMatter
      ? (body: string): Promise<boolean> =>
          markdownDocuments.mdSave(prependFrontMatter(frontMatter.raw, body))
      : markdownDocuments.mdSave

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          {/* Why: keyed for remount like MonacoEditor; boundary contains a TipTap render crash (issue #826) to this pane. */}
          <RichMarkdownErrorBoundary key={viewStateScopeId} fileId={activeFile.id}>
            <RichMarkdownEditor
              fileId={activeFile.id}
              viewStateId={viewStateScopeId}
              content={editorContent}
              filePath={activeFile.filePath}
              worktreeId={activeFile.worktreeId}
              externalSshTargetId={activeFile.externalSshTargetId}
              runtimeEnvironmentId={activeFile.runtimeEnvironmentId}
              scrollCacheKey={`${editorViewStateKey}:rich`}
              onContentChange={onContentChange}
              onDirtyStateHint={handleDirtyStateHint}
              onSave={onSave}
              onOpenDocLink={markdownDocuments.onOpenDocLink}
              markdownDocuments={markdownDocuments.markdownDocuments}
              showTableOfContents={showMarkdownTableOfContents}
              onCloseTableOfContents={onCloseMarkdownTableOfContents}
              markdownAnnotationsEnabled={markdownAnnotationsEnabled}
              markdownAnnotationFilePath={activeFile.relativePath}
              markdownSourceLineOffset={
                frontMatter ? getMarkdownSourceLineOffset(frontMatter.raw) : 0
              }
              markdownReviewContent={currentContent}
              // Why: banner goes below the toolbar (inside the editor shell) so formatting controls stay at the top of the pane.
              headerSlot={
                frontMatter && showMarkdownFrontmatter ? (
                  <FrontMatterBanner raw={frontMatter.raw} />
                ) : null
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
            {...markdownDocuments.previewProps}
          />
        </div>
      </div>
    )
  }
  return <div className="h-full min-h-0">{monacoEditor}</div>
}

function FrontMatterBanner({ raw }: { raw: string }): React.JSX.Element {
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
