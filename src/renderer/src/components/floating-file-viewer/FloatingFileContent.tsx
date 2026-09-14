import { Suspense } from 'react'
import { ImageViewer, MarkdownPreview, MonacoEditor } from '../editor/editor-lazy-views'
import { EditorFileLoadErrorView } from '../editor/EditorFileLoadErrorView'
import { useFloatingFileContent } from './use-floating-file-content'
import type { FloatingFileViewer } from './floating-file-viewer-state'
import { translate } from '@/i18n/i18n'

const noop = () => {}
export function FloatingFileContent({
  viewer,
  visible
}: {
  viewer: FloatingFileViewer
  visible: boolean
}) {
  const { content, error, reload } = useFloatingFileContent(viewer, visible)
  if (error) {
    return <EditorFileLoadErrorView message={error} onRetry={reload} />
  }
  if (!content) {
    return (
      <div role="status" className="p-4 text-sm text-muted-foreground">
        {translate('auto.components.editor.ImageViewer.3ef9551ba2', 'Loading preview...')}
      </div>
    )
  }
  return (
    <Suspense fallback={null}>
      {content.isImage || content.mimeType === 'application/pdf' ? (
        <ImageViewer
          content={content.content}
          filePath={viewer.filePath}
          mimeType={content.mimeType}
          scrollCacheKey={viewer.id}
          preserveZoomOnUpdate
          disablePopup
        />
      ) : content.isBinary ? (
        <div className="p-4 text-sm text-muted-foreground">
          {translate('floatingFileViewer.binary', 'Preview is not available for this file type.')}
        </div>
      ) : viewer.language === 'markdown' ? (
        <MarkdownPreview
          content={content.content}
          filePath={viewer.filePath}
          sourceWorktreeId={viewer.worktreeId}
          sourceRuntimeEnvironmentId={
            viewer.owner.kind === 'runtime' ? viewer.owner.environmentId : null
          }
          scrollCacheKey={viewer.id}
        />
      ) : (
        <MonacoEditor
          fileId={viewer.id}
          filePath={viewer.filePath}
          viewStateKey={viewer.id}
          relativePath={viewer.relativePath}
          content={content.content}
          language={viewer.language}
          worktreeId={viewer.worktreeId}
          readOnly
          markdownAnnotationsEnabled={false}
          conflictDecorationsEnabled={false}
          onContentChange={noop}
          onSave={noop}
        />
      )}
    </Suspense>
  )
}
