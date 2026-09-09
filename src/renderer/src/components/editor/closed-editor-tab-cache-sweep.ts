import type { PdfViewPosition } from '@/lib/scroll-cache'

/**
 * Drops every pane-scoped (`<owner>::<pane>…`) entry belonging to any of `owners` in one pass over
 * the cache, rather than one pass per owner. Split out from the cleanup hook so it is testable
 * without pulling in the hook's `monaco-editor` import.
 */
export function deletePaneScopedCacheEntries<T>(
  cache: Map<string, T>,
  owners: readonly string[]
): void {
  if (owners.length === 0) {
    return
  }

  const ownerSet = new Set(owners)
  for (const key of cache.keys()) {
    if (hasPaneScopeOwner(key, ownerSet)) {
      cache.delete(key)
    }
  }
}

/** Equivalent to `key.startsWith(`${owner}::`)` for any owner in the set, probing `::` boundaries. */
function hasPaneScopeOwner(key: string, owners: ReadonlySet<string>): boolean {
  for (
    let boundary = key.indexOf('::');
    boundary !== -1;
    // `+ 1`, not `+ 2`: in a `:::` run the second `::` starts one char after the first, and it can
    // be the only boundary an owner ends at (owner `a:` against key `a:::b`). Skipping to `+ 2`
    // steps over it and silently leaks that entry.
    boundary = key.indexOf('::', boundary + 1)
  ) {
    if (owners.has(key.slice(0, boundary))) {
      return true
    }
  }

  return false
}

/** Release the PDF positions closed edit tabs own. */
export function sweepClosedPdfViewPositions(
  cache: Map<string, PdfViewPosition>,
  filePaths: readonly string[]
): void {
  // Why: the `::`-scoped sweep does not cover the single-colon suffix, so the
  // unscoped key needs its own delete (same shape as :rich / :preview).
  for (const filePath of filePaths) {
    cache.delete(`${filePath}:pdf`)
  }
  deletePaneScopedCacheEntries(cache, filePaths)
}
