import type { PdfViewPosition } from '@/lib/scroll-cache'

function deleteCacheEntriesByPrefix<T>(cache: Map<string, T>, prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key)
    }
  }
}

/**
 * Release the PDF positions a closed edit tab owns. Split out from the cleanup
 * hook so it is testable without pulling in the hook's `monaco-editor` import.
 */
export function sweepClosedPdfViewPositions(
  cache: Map<string, PdfViewPosition>,
  filePath: string
): void {
  // Why: the `::`-scoped sweep does not cover the single-colon suffix, so the
  // unscoped key needs its own delete (same shape as :rich / :preview).
  cache.delete(`${filePath}:pdf`)
  deleteCacheEntriesByPrefix(cache, `${filePath}::`)
}
