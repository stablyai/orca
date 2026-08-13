import { isSpreadsheetMimeType } from '../../../../shared/spreadsheet-file-extensions'

export type BinaryFilePreviewKind = 'spreadsheet' | 'image' | 'unsupported'

/**
 * Picks the viewer for a file the read path classified as binary.
 *
 * Why the mime type wins over `isImage`: the read path sets `isImage` for every
 * previewable binary, including PDFs and workbooks, to stay compatible with
 * older callers. The flag therefore only means "previewable", so the concrete
 * kind has to come from the mime type first.
 */
export function getBinaryFilePreviewKind({
  mimeType,
  isImage
}: {
  mimeType?: string
  isImage?: boolean
}): BinaryFilePreviewKind {
  if (isSpreadsheetMimeType(mimeType)) {
    return 'spreadsheet'
  }
  return isImage === true ? 'image' : 'unsupported'
}
