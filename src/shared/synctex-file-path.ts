const SYNCTEX_GZIP_SUFFIX = '.synctex.gz'
const PDF_SUFFIX_RE = /\.pdf$/i

/** What hosts report for `.synctex.gz`: returned base64 like a preview, but never an image. */
export const SYNCTEX_GZIP_MIME_TYPE = 'application/gzip'

export function isSynctexGzipPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(SYNCTEX_GZIP_SUFFIX)
}

/**
 * Why: hosts return unknown binaries as empty content, so SyncTeX data needs its own
 * allowance. It stays compressed on the wire (it can be tens of MB inflated, past the
 * SSH relay's frame budget) and the renderer inflates it.
 */
export function synctexGzipMimeType(filePath: string): string | undefined {
  return isSynctexGzipPath(filePath) ? SYNCTEX_GZIP_MIME_TYPE : undefined
}

/** A host's reply for a previewable binary; the renderer keys preview rendering off `isImage`. */
export function binaryPreviewReadResult(
  base64: string,
  mimeType: string
): { content: string; isBinary: true; isImage: boolean; mimeType: string } {
  return { content: base64, isBinary: true, isImage: mimeType !== SYNCTEX_GZIP_MIME_TYPE, mimeType }
}

/**
 * Where a TeX build leaves SyncTeX data for `<job>.pdf`: `-synctex=1` writes
 * `<job>.synctex.gz`, `-synctex=-1` writes an uncompressed `<job>.synctex`.
 */
export function synctexPathsForPdf(pdfPath: string): string[] {
  if (!PDF_SUFFIX_RE.test(pdfPath)) {
    return []
  }
  const base = pdfPath.replace(PDF_SUFFIX_RE, '')
  return [`${base}${SYNCTEX_GZIP_SUFFIX}`, `${base}.synctex`]
}
