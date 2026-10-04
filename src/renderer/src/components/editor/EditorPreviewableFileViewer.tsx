import { useMemo, type JSX } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { ImageViewer } from './editor-lazy-views'
import type { PdfAnnotationContext } from './use-pdf-annotate-mode'
import { usePdfSynctex } from './use-pdf-synctex'

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
  const synctex = usePdfSynctex(file, content)
  const pdfAnnotation = useMemo<PdfAnnotationContext>(
    () => ({
      fileKey: file.id,
      worktreeId: file.worktreeId,
      displayPath: file.relativePath,
      synctex
    }),
    [file.id, file.worktreeId, file.relativePath, synctex]
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
