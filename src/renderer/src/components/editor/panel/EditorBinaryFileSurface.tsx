import { useTranslate } from '@/i18n/use-translate'
import { getConnectionIdForFile } from '@/lib/workspace/ownership/connection-context'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { ImageViewer, MediaViewer, ParquetViewer } from '../editor-lazy-views'
import {
  USER_RETRY,
  type FileContent,
  type ReloadContentOptions
} from '../loading/editor-panel-content-types'
import { PluginFileTypeSuggestion } from '../plugin-editors/PluginFileTypeSuggestion'
import { BinaryFileDefaultAppButton } from '../document-media/BinaryFileDefaultAppButton'
import { PluginEditorSourceFallbackNotice } from '../plugin-editors/PluginEditorNeedsDesktopNotice'
import { isParquetFilePath } from '../parquet/parquet-file-content'

export function EditorBinaryFileSurface({
  activeFile,
  fileContent,
  pdfViewStateKey,
  pdfPreferenceKey,
  reloadContent
}: {
  activeFile: OpenFile
  fileContent: FileContent
  pdfViewStateKey: string
  pdfPreferenceKey: string
  reloadContent: (file: OpenFile, options?: ReloadContentOptions) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (fileContent.mediaUrl && !fileContent.isImage) {
    return (
      <MediaViewer
        key={fileContent.mediaUrl}
        src={fileContent.mediaUrl}
        mimeType={fileContent.mimeType ?? 'video/mp4'}
        filePath={activeFile.filePath}
        playbackCacheKey={pdfViewStateKey}
        canOpenLocally={
          !activeFile.externalSshTargetId &&
          !activeFile.runtimeEnvironmentId &&
          getConnectionIdForFile(activeFile.worktreeId, activeFile.filePath) === null
        }
      />
    )
  }
  if (fileContent.byteSource && isParquetFilePath(activeFile.filePath)) {
    return (
      <ParquetViewer
        key={activeFile.id}
        source={fileContent.byteSource}
        byteSize={fileContent.size}
        preferenceKey={pdfPreferenceKey}
        onReload={() => reloadContent(activeFile, USER_RETRY)}
      />
    )
  }
  if (fileContent.isImage) {
    return (
      <ImageViewer
        content={fileContent.content}
        src={fileContent.mediaUrl}
        byteSize={fileContent.size}
        filePath={activeFile.filePath}
        mimeType={fileContent.mimeType}
        preferenceKey={pdfPreferenceKey}
        scrollCacheKey={pdfViewStateKey}
      />
    )
  }
  return (
    <div className="flex h-full flex-col">
      <PluginEditorSourceFallbackNotice fileId={activeFile.id} filePath={activeFile.filePath} />
      <PluginFileTypeSuggestion filePath={activeFile.filePath} />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        {t('auto.components.editor.EditorContent.b9de81ba52', 'Binary file — cannot display')}
        {fileContent.byteSource && (
          <BinaryFileDefaultAppButton key={activeFile.id} source={fileContent.byteSource} />
        )}
      </div>
    </div>
  )
}
