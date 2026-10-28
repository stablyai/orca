import { IMAGE_FILE_MIME_TYPES } from './image-file-extensions'
import { MEDIA_FILE_MIME_TYPES } from './media-file-extensions'

export type FilePreviewKind = 'image' | 'pdf' | 'audio' | 'video'
export type FilePreview = { kind: FilePreviewKind; mimeType: string }

/** Images and PDFs, which local reads, `files.readPreview` and git blobs send whole. */
export const IMAGE_AND_PDF_PREVIEW_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ...IMAGE_FILE_MIME_TYPES,
  '.avif': 'image/avif',
  '.pdf': 'application/pdf'
})

/** The extension as `.ext`, lower-cased; a bare dotfile such as `.mp4` has none. */
export function filePreviewExtension(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** Which viewer opens a file; null means it has no preview and opens as text or as "binary". */
export function filePreviewForPath(filePath: string): FilePreview | null {
  const extension = filePreviewExtension(filePath)
  const document = IMAGE_AND_PDF_PREVIEW_MIME_TYPES[extension]
  if (document) {
    return { kind: document === 'application/pdf' ? 'pdf' : 'image', mimeType: document }
  }
  const media = MEDIA_FILE_MIME_TYPES[extension]
  if (media) {
    return { kind: media.startsWith('audio/') ? 'audio' : 'video', mimeType: media }
  }
  return null
}

/** Audio and video always stream by range; their players can't take base64. */
export function streamsPreviewByRange(preview: FilePreview | null): boolean {
  return preview?.kind === 'audio' || preview?.kind === 'video'
}

/** Images and PDFs read a URL when their viewer asks, and base64 elsewhere (diffs, the web client). */
export function isDocumentPreview(preview: FilePreview | null): boolean {
  return preview?.kind === 'image' || preview?.kind === 'pdf'
}
