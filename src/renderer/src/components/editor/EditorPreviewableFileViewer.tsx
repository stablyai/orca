import { useMemo, type JSX } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { ImageViewer } from './editor-lazy-views'
import type { PdfAnnotationContext } from './use-pdf-annotate-mode'

export function EditorPreviewableFileViewer({
  file,
  content,
  mimeType,
  preferenceKey,
  scrollCacheKey
}: {
  file: OpenFile
  content: string
  mimeType?: string
  preferenceKey: string
  scrollCacheKey: string
}): JSX.Element {
  const pdfAnnotation = useMemo<PdfAnnotationContext>(
    () => ({ fileKey: file.id, worktreeId: file.worktreeId, displayPath: file.relativePath }),
    [file.id, file.worktreeId, file.relativePath]
  )
  return (
    <ImageViewer
      content={content}
      filePath={file.filePath}
      mimeType={mimeType}
      preferenceKey={preferenceKey}
      scrollCacheKey={scrollCacheKey}
      pdfAnnotation={pdfAnnotation}
    />
  )
}
